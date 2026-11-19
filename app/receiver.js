// 接收进度：右下角接收条的数据来源
//
// 两路数据，谁准用谁：
// 1. 电脑 → 电脑：对方也装了 TailDrop，会把文件名、大小、进度直接推过来（notify.js）。
// 2. 手机等其它设备 → 电脑：Tailscale 中途不报进度，只能看它的后台进程往硬盘写了多少
//    （iometer.js），得到"已收多少 + 速度"；每个文件收完时 Tailscale 会发一条完成通知，
//    带真实文件名和大小，到时再把这一行换成"已接收"。
//
// 已接收的行一直留着，直到弹窗收起（main.js 调 clearDone）。

const { readTailscaledIo } = require('./iometer');
const { createNotifyServer } = require('./notify');
const dbg = require('./dbg');

const TICK_MS = 1000;                    // 后台写盘计数大约每秒更新一次，再快没意义
// 后台平时也在写日志（实测每秒几 KB 到 100 多 KB，随网络状况变化），
// 所以先量出"平时写多少"，判断和计数都只看超出平时的那部分。
const NOISE_WINDOW = 30;                 // 用最近 30 拍空闲数据估算平时写入量
const NOISE_DEFAULT = 64 * 1024;         // 还没量够时先按这个算
const START_BYTES = 256 * 1024;          // 超出平时这么多，连续两拍 → 判定开始接收
const START_BURST_BYTES = 1024 * 1024;   // 单拍超出这么多 → 立即判定
const ACTIVE_BYTES = 64 * 1024;          // 超出平时不到这个量算"没动静"
const IDLE_END_MS = 4000;                // 没动静这么久 → 这一轮接收结束
const WARMUP_MS = 5000;                  // 刚启动先只量平时写入量，不判定接收
const SPEED_WINDOW_MS = 3000;            // 速度按最近 3 秒算，免得一跳一跳
const PUSH_STALE_MS = 15000;             // 推送方这么久没消息 → 当它断了
const PUSH_QUIET_MS = 3000;              // 推送刚结束的这段时间，硬盘计数不另起一行
const CONFIRM_WAIT_MS = 10000;           // 对方说"传完了"之后，最多等这么久本机的完成通知来确认到账
const ARRIVAL_KEEP_MS = 30 * 1000;       // 本机先收完、对方的进度消息后到：这段时间内还能对上号
const LATE_KEEP_MS = 30 * 1000;          // 显示"未确认"之后，这段时间内本机确认到了还能就地改成"已接收"
const MAX_EXPECTED = 500;
// 完成通知常常比写盘计数先到（小文件不到 1 秒就收完）：通知到时还没被计数的那部分字节，
// 之后几拍里看到时要先抵掉，不能当成"又来了一个新文件"
const CREDIT_MS = 3000;
const MAX_DONE_ROWS = 30;
const MAX_SEEN = 500;

function createReceiver(bus, devices, emit, { readIo = readTailscaledIo } = {}) {
  const server = createNotifyServer(onPush);
  const seen = new Set();          // 已处理过的完成通知（文件名 + 开始时间）
  const pushes = new Map();        // 电脑→电脑：id -> 会话
  // 电脑→电脑：对方说要发的每个文件，等本机 Tailscale 的完成通知来确认真的收到了
  // [{ sid, i, name, size, peer, confirmed, waitUntil, muted }]
  let expected = [];
  let arrivals = [];               // 本机已收完、还没对上推送会话的文件 [{ name, size, at, rowKey, muted }]
  let done = [];                   // 已接收 / 失败 / 未确认的行，最新的在前
  let disk = null;                 // 手机→电脑：当前这一轮
  let prevIo = null;
  let streak = 0;
  let lastNet = 0;
  let idleNets = [];               // 空闲时每拍的写入量，用来估算"平时写多少"
  let lastPushAt = 0;
  let credit = 0;                  // 已经收完、但写盘计数还没看到的字节
  let creditAt = 0;
  let lastSig = '[]';
  let bootAt = 0;
  let timer = null;
  let unsubscribe = null;
  let unwatchDevices = null;

  function start() {
    if (timer) return;
    bootAt = Date.now();
    unsubscribe = bus.subscribe(onBus);
    unwatchDevices = devices.onChange(() => server.bind(devices.selfAddr));
    server.bind(devices.selfAddr);
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    if (unwatchDevices) unwatchDevices();
    server.close();
  }

  // ---------- 手机 → 电脑：看后台写盘量 ----------

  function tick() {
    const now = Date.now();
    expirePushes(now);

    const io = readIo();
    if (!io) {
      // 读不到后台写盘计数（比如 Tailscale 服务停了）：照样按时结束这一轮，别一直挂着"正在接收"
      if (disk && now - disk.lastActive > IDLE_END_MS) endDisk('noio');
      return;
    }
    if (!prevIo || prevIo.pid !== io.pid) { prevIo = io; return; }   // 后台重启过：重新起算
    // 写入 − 读出：收到的数据只写不读；文件收完后被挪进"下载"时是一读一写，正好抵消
    const net = (io.write - prevIo.write) - (io.read - prevIo.read);
    prevIo = io;

    if (pushActive(now)) {             // 电脑→电脑时以对方推来的进度为准
      streak = 0;
      if (disk) endDisk('push');
      return;
    }

    let extra = Math.max(0, net - noiseFloor());   // 超出平时的部分才算接收

    // 先抵掉"已经收完的文件"剩下的那部分
    if (credit > 0 && now - creditAt > CREDIT_MS) credit = 0;
    const paid = Math.min(credit, extra);
    if (paid > 0) {
      credit -= paid;
      extra -= paid;
      dbg.log('credit paid', paid, 'left', credit);
    }

    if (disk) {
      disk.received += extra;
      disk.samples.push({ t: now, c: disk.received });
      while (disk.samples.length > 2 && now - disk.samples[0].t > SPEED_WINDOW_MS) disk.samples.shift();
      if (extra >= ACTIVE_BYTES) { disk.lastActive = now; disk.between = false; }
      if (now - disk.lastActive > IDLE_END_MS) endDisk('idle');
      else publish();
      return;
    }

    if (paid > 0) { streak = 0; return; }   // 这一拍是上一个文件的尾巴：不算平时写入，也不算新开始
    learnNoise(net);
    if (now - bootAt < WARMUP_MS) return;
    streak = extra >= START_BYTES ? streak + 1 : 0;
    if (extra >= START_BURST_BYTES || streak >= 2) {
      dbg.log('disk start net', net, 'floor', noiseFloor());
      beginDisk(extra + (streak >= 2 ? lastNet : 0), now);
      streak = 0;
    }
    lastNet = extra;
  }

  function learnNoise(net) {
    idleNets.push(Math.max(0, net));
    if (idleNets.length > NOISE_WINDOW) idleNets.shift();
  }

  // 平时写入量：取最近空闲数据里偏高的那档（第 90 百分位），宁可少算一点也别误报
  function noiseFloor() {
    if (idleNets.length < 5) return NOISE_DEFAULT;
    const sorted = idleNets.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.9)];
  }

  function beginDisk(bytes, now) {
    disk = {
      id: now,
      received: bytes,
      samples: [{ t: now, c: bytes }],
      lastActive: now,
      peer: guessPeer(),
      muted: false,
      between: false,              // 刚收完一个文件、下一个还没开始
    };
    dbg.log('disk begin', bytes, disk.peer ? disk.peer.name : '-');
    publish();
  }

  function endDisk(why) {
    dbg.log('disk end', why, disk.received);
    disk = null;
    publish();
  }

  function diskSpeed() {
    const s = disk.samples;
    const a = s[0];
    const b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt >= 0.9 ? Math.max(0, (b.c - a.c) / dt) : 0;
  }

  // ---------- 每个文件收完：Tailscale 的完成通知 ----------
  //
  // 两路消息怎么对号（电脑→电脑）：
  //   本机完成通知 = 真的收到了（arrivals）；对方推来的清单 = 对方说要发什么（expected）。
  //   只有"同名、大小完全一致、而且只可能是那一次发送"时才合并成一行；
  //   对不上或分不清时，本机收件单独一行（写实际收到的大小），对方报告的结果也单独保留。

  function onBus(msg) {
    // 总线只在实时变化时才带 IncomingFiles（启动时的初始快照里没有这一项，已实测），
    // 所以这里收到的完成记录都是刚发生的，包括启动前开始、启动后才收完的文件
    if (!msg.IncomingFiles) return;
    let changed = false;
    for (const f of msg.IncomingFiles) {
      if (!f.Done) continue;
      const key = `${f.Name}|${f.Started}`;
      if (seen.has(key)) continue;
      remember(key);

      const name = f.Name;   // Tailscale 给的已经是真实文件名，不能再解码（否则 a%20b 会变成 a b）
      const size = fileSize(f);
      dbg.log('bus done', name, size);
      const a = { name, size, at: Date.now(), rowKey: null, muted: false };
      if (claimArrival(a)) { changed = true; continue; }   // 能唯一对上某次电脑→电脑的发送：算到那一行里

      // 这个文件还有多少字节没被计数（通知比计数先到）：记账，之后看到时抵掉
      const counted = disk ? disk.received : 0;
      credit += Math.max(0, (size || 0) - counted);
      creditAt = Date.now();
      if (disk) {
        // 这个文件收完了：进行中的计数从零开始数下一个，没动静之前先不显示
        disk.received = 0;
        disk.samples = [{ t: Date.now(), c: 0 }];
        disk.between = true;
      }
      if (disk && disk.muted) {
        a.muted = true;                    // 这一轮被手动关掉了，传完也不再弹
      } else {
        a.rowKey = `done:${key}`;
        addDone({ key: a.rowKey, name, size, peer: disk ? disk.peer : guessPeer(), at: a.at });
      }
      arrivals = [...arrivals, a];
      changed = true;
    }
    if (changed) publish();
  }

  function remember(key) {
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  }

  function pruneArrivals(now) {
    arrivals = arrivals.filter((a) => now - a.at < ARRIVAL_KEEP_MS);
  }

  // ---------- 电脑 → 电脑：对方推来的进度 ----------

  function onPush(remote, msg) {
    const now = Date.now();
    // 只认当前在线设备列表里的电脑；不认识的地址发来的进度一律不显示
    const dev = devices.cache.find((x) => x.addr === remote);
    if (!dev) { dbg.log('push ignored, unknown peer', remote); return; }
    let s = pushes.get(msg.id);
    if (!s) {
      s = { id: msg.id, peer: toPeer(dev), muted: false, startAt: now };
      pushes.set(msg.id, s);
      dbg.log('push begin', remote, msg.files.length);
      if (disk) endDisk('push');
      const fresh = msg.files.map((f, i) => ({
        sid: s.id, i, name: f.name, size: f.size, peer: s.peer, startAt: now,
        state: 'pending', waitUntil: 0, dropAt: 0, at: 0, muted: false,
      }));
      expected = [...expected, ...fresh];
    }
    Object.assign(s, {
      files: msg.files, cur: msg.cur, sent: msg.sent, speed: msg.speed,
      state: msg.state, failed: new Set(msg.failed), at: now,
    });
    trimExpected();
    lastPushAt = now;
    if (s.state !== 'progress') finishPush(s, s.files.length);
    reconcile();
    publish();
  }

  // upto：前多少个文件算收完；超时断开时只认已经传完的那部分
  // 对方说"已传完"不算数：要等本机 Tailscale 的完成通知确认到账，才显示"已接收"
  function finishPush(s, upto) {
    pushes.delete(s.id);
    const now = Date.now();
    const keep = [];
    for (const e of expected) {
      if (e.sid !== s.id) { keep.push(e); continue; }
      e.muted = e.muted || s.muted;
      const row = { key: pushKey(e), name: e.name, size: e.size, peer: e.peer };
      // 本机已确认到账：不管对方最后报到第几个（结束消息丢了、超时断开），都照实显示"已接收"
      if (e.state === 'confirmed') { if (!e.muted) addDone({ ...row, at: e.at }); continue; }
      if (e.i >= upto) continue;                                 // 没传到的文件：放开，之后到了按普通方式提醒
      const failed = s.failed.has(e.i) || (s.state === 'error' && !s.failed.size);
      if (failed) { if (!e.muted) addDone({ ...row, failed: true }); continue; }
      e.state = 'waiting';                                       // 对方说发完了：等本机完成通知
      e.waitUntil = now + CONFIRM_WAIT_MS;
      keep.push(e);
    }
    expected = keep;
  }

  // 这个文件现在能不能认领本机的一条完成通知：还在排队、没轮到的文件不可能先到账
  function claimable(e) {
    if (e.state === 'waiting' || e.state === 'late') return true;
    if (e.state !== 'pending') return false;
    const s = pushes.get(e.sid);
    return !!s && e.i <= s.cur;
  }

  // 大小必须完全一致才算同一个文件（0 字节也是确定的大小）；本机不知道大小时只看名字
  function sizeMatches(got, want) {
    return got == null || got === want;
  }

  // 一条本机收件能唯一对上哪个文件：对不上、或者有好几次发送都可能，就先不认
  function claimArrival(a) {
    const cands = expected.filter((e) => claimable(e) && e.name === a.name && sizeMatches(a.size, e.size));
    if (cands.length !== 1) return null;
    return confirm(cands[0], a);
  }

  function confirm(e, a) {
    e.at = a.at;
    if (a.muted) e.muted = true;                 // 这条收件用户已经关掉看过了：之后对上也不再弹
    if (e.state === 'pending') { e.state = 'confirmed'; return e; }
    // 发送已经结束（等确认中 / 已显示"未确认"）：就地改成"已接收"
    if (!e.muted) addDone({ key: pushKey(e), name: e.name, size: e.size, peer: e.peer, at: a.at });
    expected = expected.filter((x) => x !== e);
    return e;
  }

  // 把一条先单独显示的本机收件并进对上的那次发送
  function absorb(a, e) {
    const target = e ? confirm(e, a) : claimArrival(a);
    if (!target) return false;
    arrivals = arrivals.filter((x) => x !== a);
    // 那次发送的提醒被关掉了，而这条收件还显示着：留着它，免得眼前这行突然消失
    if (a.rowKey && !target.muted) done = done.filter((r) => r.key !== a.rowKey);
    return true;
  }

  // 有新证据时（新会话、对方前进到下一个文件、某次发送失败或结束）重新试着对号
  function reconcile() {
    pruneArrivals(Date.now());
    for (const a of arrivals.slice()) absorb(a);
  }

  // 断点续传：完成通知里只有这次补传的字节数。只在对方说"发完了"、又一直等不到同样大小的确认时，
  // 才把"同名、更小、而且是这次发送开始之后才收到"的那条本机记录算进来；同名的发送或记录不止一条就不认
  function resumedArrival(e) {
    const rivals = expected.filter((x) => x !== e && x.name === e.name && claimable(x));
    if (rivals.length) return null;
    const hits = arrivals.filter((a) => a.name === e.name && a.size != null && a.size < e.size && a.at >= e.startAt);
    return hits.length === 1 ? hits[0] : null;
  }

  function expirePushes(now) {
    let changed = false;
    for (const s of [...pushes.values()]) {
      if (now - s.at > PUSH_STALE_MS) {
        dbg.log('push stale', s.id);
        finishPush(s, s.cur);   // 对方断了：没传到的文件放开，之后到了按普通方式提醒
        changed = true;
      }
    }
    pruneArrivals(now);
    // 对方说传完了，但等了一阵本机都没收到完成通知：不一定是失败（可能只是通知丢了），显示"未确认"。
    // 这一行和那次发送的对应关系留着，之后确认到了就地改成"已接收"
    for (const e of expected.filter((x) => x.state === 'waiting' && now > x.waitUntil)) {
      const a = resumedArrival(e);
      if (a && absorb(a, e)) { changed = true; continue; }
      e.state = 'late';
      e.dropAt = now + LATE_KEEP_MS;
      if (!e.muted) addDone({ key: pushKey(e), name: e.name, size: e.size, peer: e.peer, unconfirmed: true });
      changed = true;
    }
    const before = expected.length;
    expected = expected.filter((x) => !(x.state === 'late' && now > x.dropAt));
    if (expected.length !== before) changed = true;
    if (changed) { reconcile(); publish(); }
  }

  // 清单太多时先丢没用的：已显示"未确认"的、还在排队没开始的（从队尾丢）；
  // 已确认到账的和正在传的一律保留，就算因此超出上限一点
  function trimExpected() {
    const over = expected.length - MAX_EXPECTED;
    if (over <= 0) return;
    const queued = (e) => {
      if (e.state !== 'pending') return false;
      const s = pushes.get(e.sid);
      return !!s && e.i > s.cur;
    };
    const victims = [...expected.filter((e) => e.state === 'late'), ...expected.filter(queued).reverse()];
    const drop = new Set(victims.slice(0, over));
    expected = expected.filter((e) => !drop.has(e));
  }

  function pushActive(now) {
    return pushes.size > 0 || now - lastPushAt < PUSH_QUIET_MS;
  }

  // ---------- 发送方是谁 ----------

  // 手机→电脑时看不出是谁发的：只有一台设备在线就是它，多台就不猜
  function guessPeer() {
    const online = devices.cache;
    return online.length === 1 ? toPeer(online[0]) : null;
  }

  // ---------- 输出给界面 ----------

  function pushKey(e) {
    return `push:${e.sid}:${e.i}`;
  }

  function entryOf(sid, i) {
    return expected.find((x) => x.sid === sid && x.i === i);
  }

  // 同一行（同一个 key）已经在列表里就原地更新，不另起一行
  function addDone(row) {
    const r = { ...row, done: !row.failed && !row.unconfirmed, at: row.at || Date.now() };
    const idx = done.findIndex((x) => x.key === r.key);
    done = idx >= 0
      ? done.map((x, j) => (j === idx ? r : x))
      : [r, ...done].slice(0, MAX_DONE_ROWS);
  }

  function activeRows() {
    const rows = [];
    for (const s of pushes.values()) {
      if (s.muted) continue;
      for (let i = 0; i < s.cur; i++) {
        const r = earlierRow(s, i, s.files[i]);
        if (r) rows.push(r);
      }
      const f = s.files[s.cur];
      const cur = entryOf(s.id, s.cur);
      if (cur && cur.muted) continue;
      if (cur && cur.state === 'confirmed') {      // 本机已经确认收完，就不再显示对方报的进度
        rows.unshift(earlierRow(s, s.cur, f));
        continue;
      }
      const received = Math.min(s.sent, f.size);
      rows.unshift({
        key: `push:${s.id}:${s.cur}`, name: f.name, size: f.size, received,
        pct: f.size ? received / f.size : null, speed: s.speed, peer: s.peer, done: false,
      });
    }
    for (const e of expected) {        // 对方说传完了、还在等本机确认的文件
      if (e.state !== 'waiting' || e.muted) continue;
      rows.unshift({ key: pushKey(e), name: e.name, size: e.size, received: e.size, pct: 1, speed: 0, peer: e.peer, done: false });
    }
    if (disk && !disk.muted && !disk.between) {
      rows.unshift({
        key: `disk:${disk.id}`, name: '正在接收文件…', size: 0,
        received: disk.received,
        pct: null, speed: diskSpeed(), peer: disk.peer, done: false, unknown: true,
      });
    }
    return rows;
  }

  // 会话里已经传过去的文件：失败 / 本机已确认到账 / 还在等确认（显示 100%）
  function earlierRow(s, i, f) {
    const key = `push:${s.id}:${i}`;
    if (s.failed.has(i)) return { key, name: f.name, size: f.size, peer: s.peer, done: false, failed: true };
    const e = entryOf(s.id, i);
    // 记录找不到（并发清单太多被挤掉了）：没法确认到账，不能说"已接收"
    if (!e) return { key, name: f.name, size: f.size, peer: s.peer, done: false, unconfirmed: true };
    if (e.muted) return null;
    if (e.state === 'confirmed') return { key, name: f.name, size: f.size, peer: s.peer, done: true, at: e.at };
    return { key, name: f.name, size: f.size, received: f.size, pct: 1, speed: 0, peer: s.peer, done: false };
  }

  function publish() {
    const list = [...activeRows(), ...done];
    const sig = JSON.stringify(list);
    if (sig === lastSig) return;
    lastSig = sig;
    emit(list);
  }

  // 弹窗收起时调用：清掉已接收的行；还在进行的这一轮、以及用户已经看过的收件，之后都静默处理
  function clearDone() {
    done = [];
    if (disk) disk.muted = true;
    for (const s of pushes.values()) s.muted = true;
    for (const e of expected) e.muted = true;
    arrivals = arrivals.map((a) => ({ ...a, muted: true, rowKey: null }));
    lastSig = '[]';
  }

  return { start, stop, clearDone };
}

// 文件大小：0 字节是真实大小；只有 Tailscale 也不知道时才是 null
function fileSize(f) {
  if (f.DeclaredSize > 0) return f.DeclaredSize;
  if (f.Received > 0) return f.Received;
  return f.DeclaredSize === 0 ? 0 : null;
}

function toPeer(d) {
  return { id: d.id, name: d.name, os: d.os, addr: d.addr, link: d.link };
}

module.exports = { createReceiver };
