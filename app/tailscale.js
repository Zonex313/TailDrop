// 找 Tailscale 的命令行程序（tailscale.exe）。
//
// 不假设安装位置，按顺序试：
// 1. 默认位置（Program Files 及其 32 位版本）
// 2. 注册表里 Tailscale 自己记的安装目录（HKLM\SOFTWARE\Tailscale IPN）
// 3. 系统服务指向的目录（服务就是用那个目录启动的）
// 4. 系统 PATH 里能找到的
// 5. 正在运行的 Tailscale 界面进程所在的目录
// 全都没有就返回 null，由调用方提示用户先安装 Tailscale。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXE = 'tailscale.exe';

function isExe(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaults() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  return roots.filter(Boolean).map((r) => path.join(r, 'Tailscale', EXE));
}

function fromRegistry() {
  const out = [];
  try {
    const q = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Tailscale IPN', '/ve'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 形如：    (默认)    REG_SZ    C:\Program Files\Tailscale\
    const m = q.split(/\r?\n/).find((l) => /REG_(SZ|EXPAND_SZ)/.test(l));
    const dir = m && m.split(/REG_(?:SZ|EXPAND_SZ)\s+/)[1];
    if (dir) out.push(path.join(dir.trim(), EXE));
  } catch { /* 没有这个键 */ }
  try {
    const q = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tailscale', '/v', 'ImagePath'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 形如：    ImagePath    REG_EXPAND_SZ    "C:\Program Files\Tailscale\tailscaled.exe"
    const m = q.split(/\r?\n/).find((l) => /REG_(SZ|EXPAND_SZ)/.test(l));
    const exe = m && m.split(/REG_(?:SZ|EXPAND_SZ)\s+/)[1];
    if (exe) out.push(path.join(path.dirname(exe.trim().replace(/^"|"$/g, '')), EXE));
  } catch { /* 服务没装 */ }
  return out;
}

function fromPath() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, EXE));
}

function fromRunningProcess() {
  try {
    const q = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process tailscale-ipn,tailscale -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique",
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return q.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((p) => path.join(path.dirname(p), EXE));
  } catch {
    return [];
  }
}

let cached;

// 按顺序问，谁先给出存在的文件就用谁（默认位置通常一下命中，不用去调 reg / powershell）
function findTailscale() {
  if (cached !== undefined) return cached;
  const sources = [defaults, fromRegistry, fromPath, fromRunningProcess];
  for (const source of sources) {
    const hit = source().find(isExe);
    if (hit) { cached = hit; return cached; }
  }
  cached = null;
  return cached;
}

module.exports = { findTailscale, defaults, fromRegistry, fromPath, fromRunningProcess };
