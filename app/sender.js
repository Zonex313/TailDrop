// 发送队列 + 实时进度
//
// 进度来源：tailscaled 在发文件时，会在内部消息总线上每秒广播一次"已发出多少字节"
// （官方命令行显示进度用的也是这个数据）。总线由 bus.js 统一维护，这里只订阅。
// 读不到广播时照常发送，只是界面上没有百分比。

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { postProgress } = require('./notify');

const SPEED_ALPHA = 0.35;                 // 速度平滑系数：越大越灵敏、越跳
const STALL_MS = 60 * 1000;               // 有进度数据时：这么久没多发出一个字节，就判定对方没响应
const BLIND_TIMEOUT_MS = 30 * 60 * 1000;  // 完全读不到进度时的兜底超时
const PUSH_EVERY_MS = 1000;               // 给对方 TailDrop 推进度的间隔
const PUSH_GIVE_UP = 3;                   // 连续推不过去几次就放弃（对方没装 TailDrop）
const BUS_DOWN_MAX_MS = 5 * 60 * 1000;    // 进度通道累计断开这么久还没恢复，就别再干等了
const TARGETS_TIMEOUT_MS = 5000;          // 「哪些设备能收文件」查询的超时

function createSender(tailscaleExe, bus, emit) {
  const queue = [];
  let busy = false;
  let current = null;     // 正在发送的任务，面板重新打开时用来恢复进度显示
  // 先问 Tailscale 这台设备能不能收文件，能收才把文件清单推给对方（避免清单先于权限检查送出去）。
  // 每笔任务都现查，不用缓存：权限刚被收回时也不会把清单漏出去；查不到一律当不能收
  function canReceive(dev) {
    if (!dev.addr) return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile(tailscaleExe, ['file', 'cp', '--targets'], { timeout: TARGETS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(false); return; }
        const addrs = new Set(String(stdout).split(/\r?\n/).map((l) => l.split('\t')[0].trim()).filter(Boolean));
        resolve(addrs.has(dev.addr));
      });
    });
  }

  function enqueue(files, dev) {
    if (!dev || !files.length) return false;
    queue.push({ files: files.slice(), dev });
    pump();
    return true;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    const unsubscribe = bus.subscribe(onMessage);
    bus.start();
    try {
      while (queue.length) await runJob(queue.shift());
    } finally {
      unsubscribe();
      bus.stop();
      busy = false;
      current = null;
    }
  }

  async function runJob({ files, dev }) {
    const sizes = files.map(fileSize);
    const total = sizes.reduce((a, b) => a + b, 0);
    const job = { dev, total, doneBytes: 0, file: null, sent: 0, speed: 0, lastSentAt: 0, lastSentBytes: 0, seen: false, lastAdvance: 0, epoch: bus.epoch };
    const allowed = dev.os === 'windows' ? await canReceive(dev) : false;
    job.push = createPush(dev, files, sizes, allowed);
    current = job;
    report(job);

    let firstError = null;
    for (let i = 0; i < files.length; i++) {
      Object.assign(job, { index: i, file: files[i], sent: 0, speed: 0, lastSentAt: 0, lastSentBytes: 0, seen: false, lastAdvance: Date.now() });
      job.push.update(job, true);
      try {
        await sendOne(job);
      } catch (e) {
        firstError = firstError || e;
        job.push.fail(i);
      }
      // 这个文件结束：当前文件记满，报一次；再并进"已完成"，下一个文件从 0 开始数，进度不会重复计算
      job.sent = sizes[i];
      report(job);
      job.doneBytes += sizes[i];
      job.sent = 0;
    }

    await job.push.finish(firstError ? 'error' : 'ok');
    const label = files.length === 1 ? path.basename(files[0]) : `${files.length} 个文件`;
    if (firstError) emit({ devId: dev.id, state: 'error', label, message: firstError.message });
    else emit({ devId: dev.id, state: 'ok', label, queueEmpty: queue.length === 0 });
  }

  function sendOne(job) {
    return new Promise((resolve, reject) => {
      const child = spawn(tailscaleExe, ['file', 'cp', job.file, `${job.dev.dnsName}:`], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });

      // 三个计时分开算：有进度时多久没前进 / 没进度时连着多久 / 进度通道一共断了多久
      let blindFrom = Date.now();
      let offlineMs = 0;
      let lastTick = Date.now();
      const watchdog = setInterval(() => {
        const now = Date.now();
        const step = now - lastTick;
        lastTick = now;
        let why = null;
        if (!bus.connected) {
          // 进度通道断了：不按"没进度"判，但断太久（累计）也不能让队列一直卡着
          offlineMs += step;
          if (offlineMs > BUS_DOWN_MAX_MS) why = '读不到发送进度太久，已停止发送';
        } else if (bus.epoch !== job.epoch) {
          // 刚重连：从现在起重新计时，不拿断线前的时间算超时
          job.epoch = bus.epoch;
          job.lastAdvance = now;
          blindFrom = now;
        } else if (job.seen ? now - job.lastAdvance > STALL_MS : now - blindFrom > BLIND_TIMEOUT_MS) {
          why = '对方没有响应，已停止发送';
        }
        if (why) {
          clearInterval(watchdog);
          child.kill();
          reject(new Error(why));
        }
      }, 1000);

      child.on('error', (e) => { clearInterval(watchdog); reject(e); });
      child.on('close', (code) => {
        clearInterval(watchdog);
        if (code === 0) resolve();
        else reject(new Error(lastLine(stderr) || `tailscale 退出码 ${code}`));
      });
    });
  }

  // 总线消息：只关心发送进度（OutgoingFiles），且只认当前这台设备、当前这个文件、还没结束的那条
  function onMessage(msg) {
    const job = current;
    if (!job || !job.file) return;
    for (const of of msg.OutgoingFiles || []) {
      if (of.Finished || of.PeerID !== job.dev.id) continue;
      const base = path.basename(job.file);
      if (of.Name !== base && decodeName(of.Name) !== base) continue;
      job.seen = true;
      if (of.Sent > job.sent) {
        const now = Date.now();
        if (job.lastSentAt) {
          const dt = (now - job.lastSentAt) / 1000;
          if (dt > 0.2) {
            const instant = (of.Sent - job.lastSentBytes) / dt;
            job.speed = job.speed ? job.speed * (1 - SPEED_ALPHA) + instant * SPEED_ALPHA : instant;
          }
        }
        job.lastSentAt = now;
        job.lastSentBytes = of.Sent;
        job.sent = of.Sent;
        job.lastAdvance = now;
        report(job);
      }
    }
  }

  function report(job) {
    emit({ devId: job.dev.id, state: 'progress', pct: progressOf(job), speed: job.speed || 0 });
    if (job.push) job.push.update(job);
  }

  // 面板重新打开时调用，拿到"正在发送"的最新状态
  function snapshot() {
    return current ? { devId: current.dev.id, state: 'progress', pct: progressOf(current), speed: current.speed || 0 } : null;
  }

  return { enqueue, snapshot };
}

// 对方也是装了 TailDrop 的 Windows 电脑时，把进度推给它，让它的接收条显示文件名和百分比。
// 推送失败不影响发送本身。
function createPush(dev, files, sizes, allowed) {
  const enabled = !!allowed && dev.os === 'windows' && !!dev.addr;
  const base = {
    v: 1,
    id: crypto.randomUUID(),
    from: os.hostname(),
    files: files.map((f, i) => ({ name: path.basename(f), size: sizes[i] })),
  };
  const failed = [];
  let fails = 0;
  let lastAt = 0;
  let inflight = null;
  let last = { cur: 0, sent: 0, speed: 0 };

  function post(state) {
    if (!enabled || fails >= PUSH_GIVE_UP) return Promise.resolve();
    const p = postProgress(dev.addr, { ...base, ...last, state, failed: failed.slice() })
      .then((ok) => { fails = ok ? 0 : fails + 1; });
    // 记下 finally 返回的那个 Promise 本身，结束时才能认出是同一次请求并清掉标记
    const tracked = p.finally(() => { if (inflight === tracked) inflight = null; });
    inflight = tracked;
    return p;
  }

  return {
    update(job, force = false) {
      last = { cur: job.index || 0, sent: job.sent || 0, speed: Math.round(job.speed || 0) };
      const now = Date.now();
      if (inflight || (!force && now - lastAt < PUSH_EVERY_MS)) return;
      lastAt = now;
      post('progress');
    },
    fail(i) { failed.push(i); },
    async finish(state) {
      if (inflight) await inflight;
      last = { ...last, cur: base.files.length - 1, sent: base.files[base.files.length - 1].size };
      await post(state);
    },
  };
}

// 0~1；总大小未知或还没开始传时返回 null（界面显示为"发送中"）
function progressOf(job) {
  if (!job.total) return null;
  const done = job.doneBytes + Math.min(job.sent, job.total);
  if (done === 0) return null;
  return Math.min(1, done / job.total);
}

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

// 发送进度里的文件名有时是 URL 编码的（中文会变成 %E6%B5%8B…），所以原样和解码后都比一次
function decodeName(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

function lastLine(s) {
  return String(s).trim().split(/\r?\n/).filter(Boolean).pop() || '';
}

module.exports = { createSender };
