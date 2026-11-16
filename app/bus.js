// Tailscale 内部消息总线：一个常驻的 `tailscale debug watch-ipn` 子进程，多个模块共用。
//
// 它会把设备上下线、线路变化、正在发送的文件进度主动推过来，不用反复启动 tailscale.exe 去问。
// 用引用计数控制：有模块要用就启动，都不用了就退出（面板关着且没在发文件时不占任何资源）。

const { spawn } = require('child_process');

function createBus(tailscaleExe) {
  const subscribers = new Set();
  let refs = 0;
  let child = null;
  let restartTimer = null;
  let started = false;   // 收到第一条有效消息

  function spawnChild() {
    if (child) return;
    child = spawn(tailscaleExe,
      ['debug', 'watch-ipn', '--initial-status', '--initial-outgoing-files', '--peer-changes', '--peer-patches'],
      { windowsHide: true });
    child.on('error', () => {});
    child.on('close', () => {
      child = null;
      started = false;
      // tailscaled 重启（比如更新 Tailscale）后自动接回来
      if (refs > 0) restartTimer = setTimeout(spawnChild, 1500);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', jsonStream((msg) => {
      started = true;
      for (const fn of subscribers) {
        try { fn(msg); } catch { /* 单个订阅出错不影响其他 */ }
      }
    }));
  }

  function killChild() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (child) { child.kill(); child = null; }
    started = false;
  }

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // 每调用一次 start 就要有一次对应的 stop
    start() { refs++; if (refs === 1) spawnChild(); },
    stop() { refs = Math.max(0, refs - 1); if (refs === 0) killChild(); },
    get running() { return !!child; },
    get connected() { return started; },
  };
}

// watch-ipn 输出的是一个接一个的多行 JSON 对象（开头还有一行 "Connected."）。
// 按大括号配对切出完整对象，字符串里的括号和转义引号不算。
function jsonStream(onObject) {
  let buf = '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  return (chunk) => {
    let start = depth > 0 ? 0 : -1;
    buf += chunk;
    let i = buf.length - chunk.length;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (depth === 0) {
        if (c === '{') { depth = 1; start = i; }
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { onObject(JSON.parse(buf.slice(start, i + 1))); } catch { /* 跳过坏数据 */ }
        start = -1;
      }
    }
    buf = depth > 0 ? buf.slice(start) : '';
  };
}

module.exports = { createBus, jsonStream };
