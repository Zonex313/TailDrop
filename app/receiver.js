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
const CLAIM_KEEP_MS = 2 * 60 * 1000;     // 推送过的文件名记多久（防止完成通知再显示一遍）
const BOOT_IGNORE_MS = 3000;             // 刚启动时总线可能带出旧记录，忽略
// 完成通知常常比写盘计数先到（小文件不到 1 秒就收完）：通知到时还没被计数的那部分字节，
// 之后几拍里看到时要先抵掉，不能当成"又来了一个新文件"
const CREDIT_MS = 3000;
const MAX_DONE_ROWS = 30;
const MAX_SEEN = 500;

function createReceiver(bus, devices, emit, { readIo = readTailscaledIo } = {}) {
  const server = createNotifyServer(onPush);
  const seen = new Set();          // 已处理过的完成通知（文件名 + 开始时间）
  const pushes = new Map();        // 电脑→电脑：id -> 会话
  let claimed = [];                // 推送会话里出现过的文件名 [{ name, at }]
  let done = [];                   // 已接收 / 失败的行，最新的在前
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
    if (!io) return;
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
    if (!msg.IncomingFiles || Date.now() - bootAt < BOOT_IGNORE_MS) return;
    let changed = false;
    for (const f of msg.IncomingFiles) {
      if (!f.Done) continue;
      const key = `${f.Name}|${f.Started}`;
      if (seen.has(key)) continue;
      remember(key);

      const name = decodeName(f.Name);
      const size = f.DeclaredSize > 0 ? f.DeclaredSize : (f.Received || 0);
      dbg.log('bus done', name, size);
      if (isClaimed(name)) continue;   // 电脑→电脑已经显示过了

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
      if (disk && disk.muted) continue;   // 这一轮被手动关掉了，传完也不再弹
      addDone({ key: `done:${key}`, name, size, peer: disk ? disk.peer : guessPeer() });
      changed = true;
    }
    if (changed) publish();
  }

  function remember(key) {
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  }

  // ---------- 电脑 → 电脑：对方推来的进度 ----------

  function onPush(remote, msg) {
    const now = Date.now();
    let s = pushes.get(msg.id);
    if (!s) {
      s = { id: msg.id, peer: peerFor(remote, msg.from), muted: false };
      pushes.set(msg.id, s);
      dbg.log('push begin', remote, msg.files.length);
      if (disk) endDisk('push');
    }
    Object.assign(s, {
      files: msg.files, cur: msg.cur, sent: msg.sent, speed: msg.speed,
      state: msg.state, failed: new Set(msg.failed), at: now,
    });
    lastPushAt = now;
    for (const f of msg.files) claim(f.name, now);
    if (s.state !== 'progress') finishPush(s, s.files.length);
    publish();
  }

  // upto：前多少个文件算收完；超时断开时只认已经传完的那部分
  function finishPush(s, upto) {
    pushes.delete(s.id);
    if (s.muted) return;
    for (let i = 0; i < upto; i++) {
      const f = s.files[i];
      const failed = s.failed.has(i) || (s.state === 'error' && !s.failed.size);
      addDone({ key: `push:${s.id}:${i}`, name: f.name, size: f.size, peer: s.peer, failed });
    }
  }

  function expirePushes(now) {
    let changed = false;
    for (const s of pushes.values()) {
      if (now - s.at > PUSH_STALE_MS) {
        dbg.log('push stale', s.id);
        finishPush(s, s.cur);
        // 对方断了，但没传完的文件可能还会继续到达：放开名字，让完成通知照常显示
        const left = new Set(s.files.slice(s.cur).map((f) => f.name));
        claimed = claimed.filter((c) => !left.has(c.name));
        changed = true;
      }
    }
    claimed = claimed.filter((c) => now - c.at < CLAIM_KEEP_MS);
    if (changed) publish();
  }

  function pushActive(now) {
    return pushes.size > 0 || now - lastPushAt < PUSH_QUIET_MS;
  }

  function claim(name, at) {
    const c = claimed.find((x) => x.name === name);
    if (c) c.at = at;
    else claimed.push({ name, at });
  }

  function isClaimed(name) {
    return claimed.some((c) => c.name === name);
  }

  // ---------- 发送方是谁 ----------

  // 手机→电脑时看不出是谁发的：只有一台设备在线就是它，多台就不猜
  function guessPeer() {
    const online = devices.cache;
    return online.length === 1 ? toPeer(online[0]) : null;
  }

  function peerFor(addr, from) {
    const d = devices.cache.find((x) => x.addr === addr);
    return d ? toPeer(d) : { name: from || addr, os: 'windows', link: null };
  }

  // ---------- 输出给界面 ----------

  function addDone(row) {
    done = [{ ...row, done: !row.failed }, ...done].slice(0, MAX_DONE_ROWS);
  }

  function activeRows() {
    const rows = [];
    for (const s of pushes.values()) {
      if (s.muted) continue;
      for (let i = 0; i < s.cur; i++) {
        const f = s.files[i];
        rows.push({ key: `push:${s.id}:${i}`, name: f.name, size: f.size, peer: s.peer, done: !s.failed.has(i), failed: s.failed.has(i) });
      }
      const f = s.files[s.cur];
      const received = Math.min(s.sent, f.size);
      rows.unshift({
        key: `push:${s.id}:${s.cur}`, name: f.name, size: f.size, received,
        pct: f.size ? received / f.size : null, speed: s.speed, peer: s.peer, done: false,
      });
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
    lastSig = '[]';
  }

  return { start, stop, clearDone };
}

function toPeer(d) {
  return { id: d.id, name: d.name, os: d.os, addr: d.addr, link: d.link };
}

// 总线里的文件名是 URL 编码的（中文会变成 %E6%B5%8B…）
function decodeName(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

module.exports = { createReceiver };
