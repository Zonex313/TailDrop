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
  let arrivals = [];               // 本机已收完、还没对上推送会话的文件 [{ name, size, at, rowKey }]
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
      const size = f.DeclaredSize > 0 ? f.DeclaredSize : (f.Received || 0);
      dbg.log('bus done', name, size);
      if (confirmExpected(name, size)) { changed = true; continue; }   // 电脑→电脑的文件：确认到账

      // 这个文件还有多少字节没被计数（通知比计数先到）：记账，之后看到时抵掉
      const counted = disk ? disk.received : 0;
      credit += Math.max(0, size - counted);
      creditAt = Date.now();
      if (disk) {
        // 这个文件收完了：进行中的计数从零开始数下一个，没动静之前先不显示
        disk.received = 0;
        disk.samples = [{ t: Date.now(), c: 0 }];
        disk.between = true;
      }
      if (disk && disk.muted) {           // 这一轮被手动关掉了，传完也不再弹
        rememberArrival(name, size, null);
        continue;
      }
      const rowKey = `done:${key}`;
      addDone({ key: rowKey, name, size, peer: disk ? disk.peer : guessPeer() });
      rememberArrival(name, size, rowKey);
      changed = true;
    }
    if (changed) publish();
  }

  // 记下"本机已收完"：电脑→电脑时对方的进度消息可能比完成通知晚到，到时候拿来对号
  function rememberArrival(name, size, rowKey) {
    const now = Date.now();
    arrivals = [...arrivals.filter((a) => now - a.at < ARRIVAL_KEEP_MS), { name, size, at: now, rowKey }];
  }

  function remember(key) {
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  }

  // ---------- 电脑 → 电脑：对方推来的进度 ----------

  function onPush(remote, msg) {
    const now = Date.now();
    // 只认当前在线设备列表里的电脑；不认识的地址发来的进度一律不显示
    const dev = devices.cache.find((x) => x.addr === remote);
    if (!dev) { dbg.log('push ignored, unknown peer', remote); return; }
    let s = pushes.get(msg.id);
    if (!s) {
      s = { id: msg.id, peer: toPeer(dev), muted: false };
      pushes.set(msg.id, s);
      dbg.log('push begin', remote, msg.files.length);
      if (disk) endDisk('push');
      msg.files.forEach((f, i) => expected.push({ sid: s.id, i, name: f.name, size: f.size, peer: s.peer, confirmed: false, waitUntil: 0, muted: false }));
      if (expected.length > MAX_EXPECTED) expected = expected.slice(-MAX_EXPECTED);
    }
    Object.assign(s, {
      files: msg.files, cur: msg.cur, sent: msg.sent, speed: msg.speed,
      state: msg.state, failed: new Set(msg.failed), at: now,
    });
    claimArrivals(s);
    lastPushAt = now;
    if (s.state !== 'progress') finishPush(s, s.files.length);
    publish();
  }

  // upto：前多少个文件算收完；超时断开时只认已经传完的那部分
  // 对方说"已传完"不算数：要等本机 Tailscale 的完成通知确认到账，才显示"已接收"
  function finishPush(s, upto) {
    pushes.delete(s.id);
    const now = Date.now();
    for (const e of expected) {
      if (e.sid !== s.id) continue;
      e.muted = e.muted || s.muted;
      // 本机已确认到账的文件：不管对方最后报到第几个（比如结束消息丢了、超时断开），都照实显示"已接收"
      if (e.confirmed) {
        if (!e.muted) addDone({ key: `push:${s.id}:${e.i}`, name: e.name, size: e.size, peer: e.peer });
        e.drop = true;
        continue;
      }
      if (e.i >= upto) { e.drop = true; continue; }            // 没传到的文件：放开，之后到了按普通方式提醒
      const failed = s.failed.has(e.i) || (s.state === 'error' && !s.failed.size);
      if (failed) {
        if (!e.muted) addDone({ key: `push:${s.id}:${e.i}`, name: e.name, size: e.size, peer: e.peer, failed: true });
        e.drop = true;
      } else {
        e.waitUntil = now + CONFIRM_WAIT_MS;                  // 等本机完成通知
      }
    }
    expected = expected.filter((e) => !e.drop);
  }

  // 本机先收完、对方的进度后到：把先记下的到账对上这个会话，单独弹过的那行换成带发送方的这一行
  function claimArrivals(s) {
    if (!arrivals.length) return;
    const now = Date.now();
    arrivals = arrivals.filter((a) => now - a.at < ARRIVAL_KEEP_MS);
    for (const a of arrivals.slice()) {
      const e = expected.find((x) => x.sid === s.id && !x.confirmed && x.name === a.name
        && sizeFits(a.size, x.size) && x.i <= s.cur);
      if (!e) continue;
      e.confirmed = true;
      arrivals = arrivals.filter((x) => x !== a);
      if (a.rowKey) done = done.filter((r) => r.key !== a.rowKey);
      else e.muted = true;                    // 那一行当初就没弹（被手动关了），现在也不弹
    }
  }

  // 大小对不对得上：续传时完成通知里的大小可能只是这次补传的部分，所以"不超过清单大小"也算
  function sizeFits(got, want) {
    return !got || !want || got <= want;
  }

  // 这个文件对方已经开始发了吗：还在排队、没轮到的文件不可能先到账
  function started(e) {
    if (e.waitUntil) return true;
    const s = pushes.get(e.sid);
    return !s || e.i <= s.cur;
  }

  // 同名的候选里优先挑大小完全一致的，其次才是续传那种"小于清单"的
  function pickExpected(name, size) {
    const cands = expected.filter((x) => !x.confirmed && x.name === name && sizeFits(size, x.size) && started(x));
    if (!cands.length) return null;
    const exact = cands.filter((x) => !size || !x.size || x.size === size);
    const pool = exact.length ? exact : cands;
    const e = pool[0];
    // 两台电脑同时发了同名文件、分不清是谁的：这一行不写发送方，免得张冠李戴
    if (new Set(pool.map((x) => x.sid)).size > 1) e.peer = null;
    return e;
  }

  // 完成通知到了：找对应的那个文件（每条通知只认一次）
  function confirmExpected(name, size) {
    const e = pickExpected(name, size);
    if (!e) return false;
    e.confirmed = true;
    if (e.waitUntil) {                                        // 推送会话已结束，就差这一步
      if (!e.muted) addDone({ key: `push:${e.sid}:${e.i}`, name: e.name, size: e.size, peer: e.peer });
      expected = expected.filter((x) => x !== e);
    }
    return true;
  }

  function expirePushes(now) {
    let changed = false;
    for (const s of pushes.values()) {
      if (now - s.at > PUSH_STALE_MS) {
        dbg.log('push stale', s.id);
        finishPush(s, s.cur);   // 对方断了：没传到的文件放开，之后到了按普通方式提醒
        changed = true;
      }
    }
    // 对方说传完了，但等了一阵本机都没收到完成通知：不一定是失败（可能只是通知丢了），显示"未确认"
    const late = expected.filter((e) => e.waitUntil && now > e.waitUntil);
    if (late.length) {
      for (const e of late) {
        if (!e.muted) addDone({ key: `push:${e.sid}:${e.i}`, name: e.name, size: e.size, peer: e.peer, unconfirmed: true });
      }
      expected = expected.filter((e) => !late.includes(e));
      changed = true;
    }
    if (changed) publish();
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

  function addDone(row) {
    done = [{ ...row, done: !row.failed && !row.unconfirmed, at: Date.now() }, ...done].slice(0, MAX_DONE_ROWS);
  }

  function activeRows() {
    const rows = [];
    for (const s of pushes.values()) {
      if (s.muted) continue;
      for (let i = 0; i < s.cur; i++) rows.push(earlierRow(s, i, s.files[i]));
      const f = s.files[s.cur];
      const cur = expected.find((x) => x.sid === s.id && x.i === s.cur);
      if (cur && cur.confirmed) {                // 本机已经确认收完，就不再显示对方报的进度
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
      if (!e.waitUntil || e.muted) continue;
      rows.unshift({ key: `push:${e.sid}:${e.i}`, name: e.name, size: e.size, received: e.size, pct: 1, speed: 0, peer: e.peer, done: false });
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
    const e = expected.find((x) => x.sid === s.id && x.i === i);
    // 记录找不到（太多文件被挤掉了）：没法确认到账，不能说"已接收"
    if (!e) return { key, name: f.name, size: f.size, peer: s.peer, done: false, unconfirmed: true };
    if (e.confirmed) return { key, name: f.name, size: f.size, peer: e.peer === null ? null : s.peer, done: true };
    return { key, name: f.name, size: f.size, received: f.size, pct: 1, speed: 0, peer: s.peer, done: false };
  }

  function publish() {
    const list = [...activeRows(), ...done];
    const sig = JSON.stringify(list);
    if (sig === lastSig) return;
    lastSig = sig;
    emit(list);
  }

  // 弹窗收起时调用：清掉已接收的行；还在进行的这一轮也不再弹，等下一轮
  function clearDone() {
    done = [];
    if (disk) disk.muted = true;
    for (const s of pushes.values()) s.muted = true;
    for (const e of expected) e.muted = true;
    lastSig = '[]';
  }

  return { start, stop, clearDone };
}

function toPeer(d) {
  return { id: d.id, name: d.name, os: d.os, addr: d.addr, link: d.link };
}

module.exports = { createReceiver };
