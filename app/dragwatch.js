// 全局检测"正在拖文件"。
//
// 原理：Windows 在真正开始一次 OLE 拖放（拖文件、拖图片、拖链接）时，会创建一个
// 类名为 "SysDragImage" 的隐藏窗口来画拖拽时跟着鼠标走的那张小图。这个窗口只在
// 拖拽进行中存在，松手（或按 Esc 取消）后立刻销毁。
// 所以只要轮询它有没有，就能准确知道"现在有人在拖东西"，而且与光标位置无关，
// 不需要再靠右下角的感应区窗口去接拖拽事件（那个窗口正是闪烁的来源）。
//
// 代价：每 50ms 调一次 FindWindowW，微秒级，可忽略。

const POLL_MS = 50;
const CONFIRM_TICKS = 2;    // 连续 2 次（约 100ms）都检测到才算真的开始，避免瞬时误判
const MIN_SHOW_MS = 120;    // 两次 onStart 之间的最小间隔，避免同一轮拖拽重复触发

function createDragWatch({ onStart, onEnd }) {
  let koffi;
  let findWindow;
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    findWindow = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
  } catch {
    return null;   // 加载不到 koffi 就直接放弃：面板仍然可以点托盘打开
  }

  let timer = null;
  let ticks = 0;
  let active = false;
  let lastStartAt = 0;

  function poll() {
    let present = false;
    try {
      present = !!findWindow('SysDragImage', null);
    } catch {
      present = false;
    }

    if (present) {
      ticks++;
      if (!active && ticks >= CONFIRM_TICKS) {
        if (process.env.TAILDROP_DEBUG) console.log('[dragwatch] START');
        active = true;
        if (Date.now() - lastStartAt >= MIN_SHOW_MS) {
          lastStartAt = Date.now();
          if (onStart) onStart();
        }
      }
    } else {
      ticks = 0;
      if (active) {
        if (process.env.TAILDROP_DEBUG) console.log('[dragwatch] END');
        active = false;
        if (onEnd) onEnd();
      }
    }
  }

  return {
    start() {
      if (timer) return;
      poll();
      timer = setInterval(poll, POLL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      ticks = 0;
      active = false;
    },
    isDragging: () => active,
  };
}

module.exports = { createDragWatch };
