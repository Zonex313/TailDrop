// 电脑 ↔ 电脑：发送方的 TailDrop 把"正在发什么、发到多少了"直接告诉接收方的 TailDrop
//
// Tailscale 收文件时中途不报进度，但发送方自己知道。两台电脑都装了 TailDrop 时，
// 发送方每秒把进度 POST 到对方的 Tailscale 地址；对方没装就连不上，发送方安静放弃。
// 只监听本机的 Tailscale 地址（100.x），局域网和公网都碰不到这个端口。

const http = require('http');

const NOTIFY_PORT = 47913;
const POST_TIMEOUT_MS = 1500;
const MAX_BODY = 16 * 1024;
const MAX_FILES = 200;
const STATES = new Set(['progress', 'ok', 'error']);

// ---------- 接收方：小服务 ----------

function createNotifyServer(onProgress) {
  let server = null;
  let boundAddr = '';

  function handle(req, res) {
    const remote = stripMapped(req.socket.remoteAddress || '');
    if (req.method !== 'POST' || req.url !== '/progress' || !isTailnetAddr(remote)) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const msg = sanitize(parseJson(Buffer.concat(chunks).toString('utf8')));
      if (!msg) { res.writeHead(400).end(); return; }
      res.writeHead(204).end();
      onProgress(remote, msg);
    });
  }

  // 地址变了（Tailscale 重新登录等）就换绑；绑不上下次再试
  function bind(addr) {
    if (!addr || addr === boundAddr) return;
    close();
    const s = http.createServer(handle);
    s.on('error', () => { if (server === s) { server = null; boundAddr = ''; } });
    s.listen(NOTIFY_PORT, addr);
    server = s;
    boundAddr = addr;
  }

  function close() {
    if (server) server.close();
    server = null;
    boundAddr = '';
  }

  return { bind, close, get boundAddr() { return boundAddr; } };
}

// ---------- 发送方：推一次进度 ----------

function postProgress(addr, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: addr,
      port: NOTIFY_PORT,
      path: '/progress',
      method: 'POST',
      timeout: POST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// ---------- 校验：对方发来的东西一律不信 ----------

function sanitize(m) {
  if (!m || m.v !== 1 || !STATES.has(m.state)) return null;
  if (!isText(m.id, 64) || !Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return null;
  const files = [];
  for (const f of m.files) {
    if (!f || !isText(f.name, 255) || !isCount(f.size)) return null;
    files.push({ name: baseName(f.name), size: f.size });
  }
  const cur = Number.isInteger(m.cur) ? Math.max(0, Math.min(files.length - 1, m.cur)) : 0;
  const failed = Array.isArray(m.failed) ? m.failed.filter((i) => Number.isInteger(i) && i >= 0 && i < files.length) : [];
  return {
    id: m.id,
    from: isText(m.from, 64) ? m.from : '',
    files,
    cur,
    sent: isCount(m.sent) ? m.sent : 0,
    speed: isCount(m.speed) ? m.speed : 0,
    state: m.state,
    failed,
  };
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isText(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// 只要文件名，不要任何路径
function baseName(name) {
  return name.split(/[\\/]/).pop() || name;
}

function stripMapped(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// Tailscale 的 IPv4 地址都在 100.64.0.0/10
function isTailnetAddr(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

module.exports = { createNotifyServer, postProgress, NOTIFY_PORT, isTailnetAddr };
