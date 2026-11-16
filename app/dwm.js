// 关闭 Windows 给窗口加的系统显示/隐藏动画（DWM transitions）。
// 原因：Windows 11 播放这个动画时不带圆角，面板收起前会有约 0.1 秒变成直角（逐帧录屏实测）。
// 关掉以后由主进程自己用窗口透明度做淡入淡出，圆角全程保持。

const DWMWA_TRANSITIONS_FORCEDISABLED = 3;

let setAttr = null;
try {
  const koffi = require('koffi');
  setAttr = koffi.load('dwmapi.dll').func(
    'long __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32_t attr, _In_ int32_t *val, uint32_t size)',
  );
} catch {
  setAttr = null;   // 没有 koffi 也能用，只是收起时可能看到一瞬间直角
}

function disableTransitions(win) {
  if (!setAttr) return false;
  const h = win.getNativeWindowHandle();
  const hwnd = h.length === 8 ? Number(h.readBigUInt64LE()) : h.readUInt32LE();
  return setAttr(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, [1], 4) === 0;
}

module.exports = { disableTransitions };
