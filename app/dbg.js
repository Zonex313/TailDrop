// 诊断日志：设置 TAILDROP_DEBUG=1 时，把接收检测的每一步写进临时文件。
// 正常使用不产生任何文件。
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.tmpdir(), 'taildrop-receive.log');
const enabled = process.env.TAILDROP_DEBUG === '1';

function log(...parts) {
  if (!enabled) return;
  const line = `${new Date().toISOString().slice(11, 23)}  ${parts.join(' ')}\n`;
  try { fs.appendFileSync(file, line); } catch {}
}

function reset() {
  if (!enabled) return;
  try { fs.writeFileSync(file, ''); } catch {}
}

module.exports = { log, reset, file, enabled };
