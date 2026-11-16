// 读 Tailscale 后台进程的累计读写字节数（手机 → 电脑时测接收进度用）
//
// 为什么这样测：Tailscale 收文件时中途不报任何进度，后台进程又以系统身份运行，
// 普通程序打不开它。但"整机进程列表"（任务管理器同款数据）谁都能读，
// 里面带着每个进程的累计读/写字节数。收文件 = 后台在往硬盘写，写入量就是进度。
//
// 后台有两个 tailscaled.exe：服务外壳 + 它启动的干活进程，只看后者。

const koffi = require('koffi');

const SystemProcessInformation = 5;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;

// SYSTEM_PROCESS_INFORMATION（x64）里用到的字段偏移
const OFF = {
  next: 0x00,
  nameLen: 0x38,
  namePtr: 0x40,
  pid: 0x50,
  parent: 0x58,
  read: 0xE8,
  write: 0xF0,
};

let query = null;
let buf = Buffer.alloc(1 << 20);

function init() {
  if (query) return true;
  try {
    const ntdll = koffi.load('ntdll.dll');
    query = ntdll.func('int32 __stdcall NtQuerySystemInformation(int cls, void *buf, uint32 len, _Out_ uint32 *ret)');
    return true;
  } catch {
    return false;
  }
}

function snapshot() {
  const ret = [0];
  let st = query(SystemProcessInformation, buf, buf.length, ret);
  if (st === STATUS_INFO_LENGTH_MISMATCH) {
    buf = Buffer.alloc(ret[0] + 64 * 1024);
    st = query(SystemProcessInformation, buf, buf.length, ret);
  }
  return st === 0;
}

// 返回 { pid, read, write }（字节，Number）；找不到或读失败返回 null
function readTailscaledIo() {
  if (!init() || !snapshot()) return null;

  const base = Number(koffi.address(buf));
  const procs = [];
  let off = 0;
  for (;;) {
    const len = buf.readUInt16LE(off + OFF.nameLen);
    const ptr = Number(buf.readBigUInt64LE(off + OFF.namePtr));
    const start = ptr - base;
    if (len && start >= 0 && start + len <= buf.length &&
        buf.toString('utf16le', start, start + len).toLowerCase() === 'tailscaled.exe') {
      procs.push({
        pid: Number(buf.readBigUInt64LE(off + OFF.pid)),
        parent: Number(buf.readBigUInt64LE(off + OFF.parent)),
        read: Number(buf.readBigUInt64LE(off + OFF.read)),
        write: Number(buf.readBigUInt64LE(off + OFF.write)),
      });
    }
    const next = buf.readUInt32LE(off + OFF.next);
    if (!next) break;
    off += next;
  }
  if (!procs.length) return null;

  // 干活进程 = 父进程也是 tailscaled.exe 的那个；老版本只有一个进程时就用它
  const pids = new Set(procs.map((p) => p.pid));
  const worker = procs.find((p) => pids.has(p.parent)) || procs[0];
  return { pid: worker.pid, read: worker.read, write: worker.write };
}

module.exports = { readTailscaledIo };
