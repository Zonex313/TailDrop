// 开机自启：直接读写 HKCU\...\Run 里的 "TailDrop" 一项。
//
// 为什么不用 Electron 的 app.setLoginItemSettings / getLoginItemSettings：
//   1. 免安装运行时（electron.exe + 项目目录参数），getLoginItemSettings().openAtLogin
//      永远返回 false，菜单上的对钩显示不出来；
//   2. 它写进注册表的命令不带引号，文件夹路径里有空格时开机就拉不起来。
// 这里用 koffi 调 Win32 注册表 API（Unicode 版），中文路径、空格路径都没问题。
//
// 另外，任务管理器「启动应用」里被禁用的项，会在 StartupApproved\Run 里记一个标记
// （第一个字节是奇数）。读的时候把它算作"没开"，重新打开时顺手清掉这个标记。

const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const VALUE_NAME = 'TailDrop';

const HKEY_CURRENT_USER = -2147483647;   // (HKEY)(LONG)0x80000001，64 位下要按有符号扩展
const KEY_QUERY_VALUE = 0x0001;
const KEY_SET_VALUE = 0x0002;
const REG_SZ = 1;
const REG_BINARY = 3;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const MAX_VALUE_BYTES = 4096;

let api = null;
function win32() {
  if (api) return api;
  const koffi = require('koffi');
  const adv = koffi.load('advapi32.dll');
  api = {
    open: adv.func('long __stdcall RegOpenKeyExW(intptr_t hKey, const char16_t *sub, uint32 opt, uint32 sam, _Out_ intptr_t *out)'),
    query: adv.func('long __stdcall RegQueryValueExW(intptr_t hKey, const char16_t *name, void *res, _Out_ uint32 *type, void *data, _Inout_ uint32 *cb)'),
    set: adv.func('long __stdcall RegSetValueExW(intptr_t hKey, const char16_t *name, uint32 res, uint32 type, const void *data, uint32 cb)'),
    del: adv.func('long __stdcall RegDeleteValueW(intptr_t hKey, const char16_t *name)'),
    close: adv.func('long __stdcall RegCloseKey(intptr_t hKey)'),
  };
  return api;
}

// 打开一个键执行 fn(hKey)；键不存在时返回 fallback
function withKey(sub, access, fallback, fn) {
  const w = win32();
  const out = [0];
  const rc = w.open(HKEY_CURRENT_USER, sub, 0, access, out);
  if (rc === ERROR_FILE_NOT_FOUND) return fallback;
  if (rc !== ERROR_SUCCESS) throw new Error(`打开注册表失败（${rc}）：${sub}`);
  try {
    return fn(out[0]);
  } finally {
    w.close(out[0]);
  }
}

// 读一个值，返回 { type, data: Buffer } 或 null（不存在）
function readValue(sub, name) {
  return withKey(sub, KEY_QUERY_VALUE, null, (h) => {
    const type = [0];
    const size = [MAX_VALUE_BYTES];
    const buf = Buffer.alloc(MAX_VALUE_BYTES);
    const rc = win32().query(h, name, null, type, buf, size);
    if (rc === ERROR_FILE_NOT_FOUND) return null;
    if (rc !== ERROR_SUCCESS) throw new Error(`读取注册表失败（${rc}）：${name}`);
    return { type: type[0], data: buf.subarray(0, size[0]) };
  });
}

function readString(sub, name) {
  const v = readValue(sub, name);
  if (!v || v.type !== REG_SZ) return null;
  return v.data.toString('utf16le').replace(/\0+$/, '');
}

// 开机时要执行的命令：exe 和参数都加引号，路径里有空格也不怕
function commandLine(exe, args) {
  return [exe, ...args].map((s) => `"${s}"`).join(' ');
}

function sameCommand(a, b) {
  const norm = (s) => s.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

// 任务管理器里被禁用了吗（StartupApproved 第一个字节为奇数表示禁用）
function disabledByUser() {
  const v = readValue(APPROVED_KEY, VALUE_NAME);
  return !!(v && v.type === REG_BINARY && v.data.length && (v.data[0] & 1));
}

function isEnabled(exe, args) {
  const cur = readString(RUN_KEY, VALUE_NAME);
  return !!cur && sameCommand(cur, commandLine(exe, args)) && !disabledByUser();
}

function setEnabled(on, exe, args) {
  withKey(RUN_KEY, KEY_SET_VALUE, null, (h) => {
    const w = win32();
    if (on) {
      const data = Buffer.from(commandLine(exe, args) + '\0', 'utf16le');
      const rc = w.set(h, VALUE_NAME, 0, REG_SZ, data, data.length);
      if (rc !== ERROR_SUCCESS) throw new Error(`写入注册表失败（${rc}）`);
    } else {
      const rc = w.del(h, VALUE_NAME);
      if (rc !== ERROR_SUCCESS && rc !== ERROR_FILE_NOT_FOUND) throw new Error(`删除注册表项失败（${rc}）`);
    }
  });
  // 打开时清掉任务管理器留下的"已禁用"标记，否则写了也不会启动
  if (on) {
    withKey(APPROVED_KEY, KEY_SET_VALUE, null, (h) => { win32().del(h, VALUE_NAME); });
  }
}

module.exports = { isEnabled, setEnabled, commandLine, readString, RUN_KEY, VALUE_NAME };
