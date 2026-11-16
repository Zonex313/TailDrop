// 读取全局鼠标按键状态（Win32 GetAsyncKeyState），用来实现"面板外按下鼠标就收起"。
// 从资源管理器拖文件过来时面板拿不到焦点，靠失焦事件判断不了，所以直接读按键。
// koffi 加载失败时返回 null，调用方退回到"失焦即收起"。

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const KEY_DOWN = 0x8000;

function createMouse() {
  let getKey;
  try {
    const koffi = require('koffi');
    getKey = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int)');
  } catch {
    return null;
  }
  const isDown = (vk) => (getKey(vk) & KEY_DOWN) !== 0;
  return {
    anyDown: () => isDown(VK_LBUTTON) || isDown(VK_RBUTTON) || isDown(VK_MBUTTON),
  };
}

module.exports = { createMouse };
