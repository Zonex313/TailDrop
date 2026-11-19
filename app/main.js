// TailDrop 拖放发送面板 — 主进程
// 结构：全局监听"正在拖文件"，拖满 0.5 秒就在右下角弹出设备面板（panel）。
// 不再使用右下角感应区窗口：它会和面板互相抢拖拽事件，造成反复闪。
// 面板窗口"存在即可见"：收起时直接销毁，下次弹出再新建。

const { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createBus } = require('./bus');
const { createDeviceSource } = require('./devices');
const { createMouse } = require('./mouse');
const { createDragWatch } = require('./dragwatch');
const autostart = require('./autostart');
const { createSender } = require('./sender');
const { createReceiver } = require('./receiver');
const { disableTransitions } = require('./dwm');
const { findTailscale } = require('./tailscale');

const DRAG_SHOW_DELAY_MS = 0;       // 检测到拖拽后不再额外等待：窗口一建好就显示（识别本身约 0.1 秒）
const PANEL = { w: 280, minH: 110, maxH: 420 };   // 高度随设备数量自动伸缩，超过上限就滚动
const PANEL_GAP = 12;               // 面板与屏幕边缘的间距
const ICON = 52;                    // 拖拽时先出现的小方块图标边长
const LEAVE_MS = 220;               // 退场动画时长，播完再销毁窗口
const COLLAPSE_MS = 380;            // 列表缩回图标的动画时长（index.html 里是 .34s），多留一点余量
const DRAG_LEAVE_HIDE_MS = 500;     // 文件拖出面板多久后收起
const PROBE_TICK_MS = 3000;         // 面板开着时，多久检查一次哪些设备需要 ping（单台设备 15 秒内不重复 ping）
const WATCHDOG_MS = 60000;          // 兜底：总线万一没推消息，每分钟拉一次完整状态
const MOUSE_POLL_MS = 40;           // 检测"面板外点击"的轮询间隔
const TRAY_TOGGLE_MS = 400;         // 刚因点外面收起时，紧接着的托盘点击视为"关闭"而不是重新打开
const FADE_IN_MS = 140;
const FADE_OUT_MS = 120;
const FADE_STEP_MS = 8;

// 接收气泡：右下角小卡片，比发送面板矮、宽一点，不抢焦点
const RECEIVE = { w: 280, minH: 74, maxH: 300 };   // 宽度与发送面板一致
const RECEIVE_GAP = 12;
const RECEIVE_HOLD_MS = 10000;      // 传完后停留多久再收起（也可以手动关）
const RECEIVE_HOVER_RETRY_MS = 1500; // 到点时鼠标正停在接收条上：稍后再试，别在要点按钮时消失

let tray = null;
let dragWatch = null;
let dragPanelAt = 0;                // 本轮拖拽里面板是自动弹出的（松手后要收起来）
let panelWin = null;
let hideTimer = null;
let showTimer = null;
let panelTimers = [];
let panelBusHeld = false;   // 面板自己是否占着一份总线引用（只释放自己申请的那份）
let lastOutsideHideAt = 0;
let panelClosing = false;
let panelMode = null;               // 'icon'：拖拽中的小图标；'full'：完整设备列表
let panelReady = false;             // 页面加载完了没有
let panelWantFocus = false;
let panelWantShow = false;          // 窗口是否该显示出来（拖拽时会先建好窗口但不显示）
let panelCardH = PANEL.minH;        // 页面量出来的卡片高度
let leaveTimer = null;
let collapseTimer = null;
let receiveWin = null;
let receiveHideTimer = null;
let receiveClosing = false;
let receiveFadeTimer = null;

// Tailscale 装在哪由 tailscale.js 去找（先看默认位置，再问注册表、服务、PATH、
// 正在运行的进程），装到别的盘或非默认目录也能用。
let TAILSCALE = null;
let bus = null;
let devices = null;
let sender = null;
let receiver = null;
const mouse = createMouse();

function initTailscale() {
  TAILSCALE = findTailscale();
  if (!TAILSCALE) return false;
  bus = createBus(TAILSCALE);
  devices = createDeviceSource(TAILSCALE, bus);
  sender = createSender(TAILSCALE, bus, onSendEvent);
  receiver = createReceiver(bus, devices, onReceiveEvent);
  return true;
}

// ---------- 工具 ----------

// 面板是一个固定大小的透明窗口，贴在右下角，按面板最大尺寸开好。
// 图标和卡片都由页面自己画（展开动画全在页面里做），窗口只负责"哪一块接得住鼠标"：
// 用 setShape 把可点区域限定在图标或卡片上，其余透明部分鼠标、拖拽都直接穿透到下面。
function panelFrame() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = PANEL.w + PANEL_GAP;
  const height = PANEL.maxH + PANEL_GAP;
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y + workArea.height - height,
    width,
    height,
  };
}

function clampCardH(h) {
  return Math.max(PANEL.minH, Math.min(PANEL.maxH, Math.round(h) || PANEL.minH));
}

// 看得见的那一块（图标或卡片）在窗口里的位置
function panelVisibleRect(mode = panelMode) {
  const f = panelFrame();
  const w = mode === 'full' ? PANEL.w : ICON;
  const h = mode === 'full' ? panelCardH : ICON;
  return { x: f.width - PANEL_GAP - w, y: f.height - PANEL_GAP - h, width: w, height: h };
}

// 可点区域 = 看得见的那块，一直延伸到窗口右下角（不做外阴影，所以不留影子边）
function applyPanelShape() {
  if (!panelAlive() || !panelMode) return;
  const f = panelFrame();
  const r = panelVisibleRect();
  const { x, y } = r;
  panelWin.setShape([{ x, y, width: f.width - x, height: f.height - y }]);
  repositionReceive();
}

function panelAlive() {
  return !!panelWin && !panelWin.isDestroyed();
}

// 正在播退场动画的面板不算"开着"
function isPanelOpen() {
  return panelAlive() && !panelClosing;
}

function panelShowing() {
  return isPanelOpen() && !!panelMode && panelWin.isVisible();
}

// 看得见的那块在屏幕上的位置
function panelScreenRect() {
  const f = panelFrame();
  const r = panelVisibleRect();
  return { x: f.x + r.x, y: f.y + r.y, width: r.width, height: r.height };
}

function cursorInPanel() {
  const p = screen.getCursorScreenPoint();
  const b = panelScreenRect();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// ---------- 发送 ----------

function onSendEvent(ev) {
  if (panelAlive()) panelWin.webContents.send('send-progress', ev);
  if (ev.state === 'ok' && ev.queueEmpty) scheduleHide(1600);   // 让用户看到"已送达"再收起
}

// ---------- 接收气泡 ----------

let lastReceiveList = [];

function onReceiveEvent(list) {
  lastReceiveList = list;
  if (!list.length) {
    scheduleReceiveHide(0);
    return;
  }
  clearTimeout(receiveHideTimer);
  showReceive(list);

  // 全部传完（或失败）后停留一会儿；还有在传的就一直开着
  const finished = list.every((f) => f.done || f.failed || f.unconfirmed);
  if (finished) scheduleReceiveHide(RECEIVE_HOLD_MS);
}

function cursorInReceive() {
  if (!receiveAlive() || !receiveWin.isVisible()) return false;
  const p = screen.getCursorScreenPoint();
  const b = receiveWin.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// 打开接收文件夹；刚收到的文件还在就顺手选中它
function openReceiveDir() {
  const dir = app.getPath('downloads');
  const latest = lastReceiveList.find((f) => f.done && f.name);
  const file = latest && findReceivedFile(dir, latest);
  if (file) shell.showItemInFolder(file);
  else shell.openPath(dir);
}

// 找到这次真正收到的那个文件：重名时 Tailscale 会存成「名字 (1).扩展名」，
// 所以按"大小一致、修改时间就在收到的那一刻附近"去认，认不准就只打开文件夹，不乱选中旧文件
const RECEIVED_MTIME_SLACK_MS = 2 * 60 * 1000;
const RECEIVED_RENAME_TRIES = 50;
function findReceivedFile(dir, f) {
  const ext = path.extname(f.name);
  const stem = f.name.slice(0, f.name.length - ext.length);
  const names = [f.name];
  for (let n = 1; n <= RECEIVED_RENAME_TRIES; n++) names.push(`${stem} (${n})${ext}`);
  const at = f.at || Date.now();
  let best = null;
  for (const name of names) {
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    if (f.size && st.size !== f.size) continue;
    const gap = Math.abs(st.mtimeMs - at);
    if (gap > RECEIVED_MTIME_SLACK_MS) continue;
    if (!best || gap < best.gap) best = { file: path.join(dir, name), gap };
  }
  return best ? best.file : null;
}

function receiveBounds(height) {
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(RECEIVE.minH, Math.min(RECEIVE.maxH, Math.round(height)));
  const x = workArea.x + workArea.width - RECEIVE.w - RECEIVE_GAP;
  let y = workArea.y + workArea.height - h - RECEIVE_GAP;
  // 发送面板（或拖拽图标）同时开着时，气泡叠到它上方，别互相遮住
  if (panelShowing()) {
    y = Math.min(y, panelScreenRect().y - h - 8);
  }
  return { x, y: Math.max(workArea.y, y), width: RECEIVE.w, height: h };
}

// 面板从图标展开、或高度变了：接收气泡跟着挪到它上方
function repositionReceive() {
  if (!receiveAlive() || !receiveWin.isVisible()) return;
  const cur = receiveWin.getBounds();
  const b = receiveBounds(cur.height);
  if (b.y !== cur.y) receiveWin.setBounds(b);
}

function receiveAlive() {
  return !!receiveWin && !receiveWin.isDestroyed();
}

function showReceive(list) {
  if (receiveAlive()) {
    if (receiveClosing) {   // 正在淡出时又来了新文件：原地淡回来
      receiveClosing = false;
      fadeReceive(receiveWin, 1, FADE_IN_MS);
    }
    receiveWin.webContents.send('receive-progress', list);
    return;
  }

  const win = new BrowserWindow({
    ...receiveBounds(RECEIVE.minH),
    frame: false,
    transparent: false,
    roundedCorners: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: false,          // 不抢焦点：正在打字时收到文件也不会打断
    hasShadow: true,
    backgroundColor: '#0e1013',
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  receiveWin = win;
  receiveClosing = false;
  disableTransitions(win);
  win.setOpacity(0);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'receive.html'));

  // 页面加载期间状态可能已经变了（比如小文件已经收完），所以发最新的，而不是建窗口时那份
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('receive-progress', lastReceiveList);
  });
  win.on('closed', () => {
    if (receiveWin !== win) return;
    receiveWin = null;
    receiveClosing = false;
  });
}

function fadeReceive(win, to, ms, done) {
  clearInterval(receiveFadeTimer);
  const from = win.getOpacity();
  const t0 = Date.now();
  receiveFadeTimer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(receiveFadeTimer);
    const k = Math.min(1, (Date.now() - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    win.setOpacity(from + (to - from) * eased);
    if (k >= 1) {
      clearInterval(receiveFadeTimer);
      receiveFadeTimer = null;
      if (done) done();
    }
  }, FADE_STEP_MS);
}

function hideReceive() {
  clearTimeout(receiveHideTimer);
  receiver.clearDone();
  if (!receiveAlive() || receiveClosing) return;
  const win = receiveWin;
  if (!win.isVisible()) return win.destroy();
  receiveClosing = true;
  fadeReceive(win, 0, FADE_OUT_MS, () => win.destroy());
}

function scheduleReceiveHide(delay) {
  clearTimeout(receiveHideTimer);
  receiveHideTimer = setTimeout(() => {
    if (delay > 0 && cursorInReceive()) return scheduleReceiveHide(RECEIVE_HOVER_RETRY_MS);
    hideReceive();
  }, delay);
}

// ---------- 面板 ----------

// 拖拽一开始就建窗口（先隐藏），页面加载完立刻显示图标；delay 可以留一点等待，现在设为 0。
// 到点时已经没在拖了，就不显示，备用的窗口直接收掉。
function scheduleShowPanel(delay) {
  clearTimeout(showTimer);
  if (panelAlive() && panelClosing) panelWin.destroy();   // 上一轮还在退场：直接换新的
  if (!panelAlive()) createPanelWindow('icon', false);   // 先藏在幕后把页面备好
  showTimer = setTimeout(() => {
    showTimer = null;
    if (!dragWatch || !dragWatch.isDragging()) {
      if (isPanelOpen() && !panelWin.isVisible()) hidePanel();   // 已经松手了：备用的窗口收掉
      return;
    }
    dragPanelAt = Date.now();
    panelWantShow = true;
    if (panelReady) revealPanel();      // 页面没加载完的话，加载完它会自己显示
  }, delay);
}

// mode = 'icon'：拖拽中先出一个小方块；'full'：直接打开完整列表（托盘、再次启动时）。
// 已经开着的话只做"升级"：图标 → 完整列表，不会反过来缩回去。
function showPanel(mode = 'full') {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  if (panelAlive() && panelClosing) {   // 正在退场时又要打开：直接销毁重来，比倒放动画干净
    panelWin.destroy();
  }
  if (panelAlive()) {
    if (mode === 'icon') {
      if (!panelWin.isVisible() && panelReady) { panelWantShow = true; revealPanel(); }
      return;
    }
    panelWantShow = true;
    expandPanel(true);
    if (!panelWin.isVisible() && panelReady) revealPanel();
    return;
  }
  createPanelWindow(mode);
}

// wantShow = false：先把窗口和页面备好，但先不显示（拖拽时用）
function createPanelWindow(mode, wantShow = true) {
  const win = new BrowserWindow({
    ...panelFrame(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,                   // 阴影由页面自己画
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  panelWin = win;
  panelClosing = false;
  panelMode = mode;
  panelReady = false;
  panelWantFocus = mode === 'full';
  panelWantShow = wantShow;
  disableTransitions(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  applyPanelShape();
  win.loadFile(path.join(__dirname, 'index.html'));

  if (process.env.TAILDROP_DEBUG) {
    win.webContents.on('console-message', (_e, level, msg) => console.log('[renderer]', msg));
  }
  win.webContents.on('did-finish-load', () => {
    if (panelWin !== win) return;
    panelReady = true;
    // 先发上次的结果让面板立刻有内容；总线连上后会自动推来最新状态
    if (devices.cache.length) win.webContents.send('devices', devices.cache);
    const sending = sender.snapshot();   // 正在发送时重新打开面板，接着显示进度
    if (sending) win.webContents.send('send-progress', sending);
    win.webContents.send('panel-mode', panelMode);
    if (win.isVisible()) win.webContents.send('panel-reveal');   // 加载完之前就已经显示了：补发
    if (mode === 'icon' && panelWantShow) revealPanel();   // 图标不用等设备数据，备好了就出来
  });
  if (!mouse) win.on('blur', () => { if (panelMode === 'full') scheduleHide(0); });

  win.on('closed', () => {
    if (panelWin !== win) return;
    panelWin = null;
    panelClosing = false;
    panelMode = null;
    panelWantShow = false;
    stopPanelTimers();
    repositionReceive();
  });
  startPanelTimers();
}

// 第一次让窗口出现在屏幕上（入场动画由页面播放）
function revealPanel() {
  if (!panelAlive() || panelWin.isVisible()) return;
  panelWantShow = true;
  // 拖拽中不抢焦点：抢焦点会让资源管理器的拖拽会话中断
  if (panelWantFocus && !(dragWatch && dragWatch.isDragging())) {
    panelWin.show();
    panelWin.focus();
  } else {
    panelWin.showInactive();
  }
  // 窗口真正出现在屏幕上了，才让页面开始播入场动画（窗口是提前在幕后建好的）
  // 页面脚本可能比 did-finish-load 先跑起来并先调 fit，所以这里不看 panelReady 直接发；
  // did-finish-load 里还会补发一次，页面那边重复收到没关系
  panelWin.webContents.send('panel-reveal');
  repositionReceive();
}

// 图标 → 完整列表。先把可点区域放大到卡片大小，再让页面播展开动画。
function expandPanel(wantFocus) {
  if (!isPanelOpen()) return;
  if (wantFocus && !(dragWatch && dragWatch.isDragging())) {
    panelWantFocus = true;
    if (panelWin.isVisible()) panelWin.focus();
  }
  if (panelMode === 'full') return;
  clearTimeout(collapseTimer);          // 正在缩回又拖回来了：不要再按图标大小收小
  panelMode = 'full';
  dragPanelAt = 0;                      // 文件已经拖到图标上了，松手不收
  applyPanelShape();
  if (panelReady) panelWin.webContents.send('panel-mode', 'full');
}

// 完整列表 → 图标。文件拖离卡片但还没松手时用它收缩，松手后再由 hidePanel 收掉。
function collapsePanel() {
  if (!isPanelOpen() || panelMode !== 'full') return;
  panelMode = 'icon';
  if (panelReady) panelWin.webContents.send('panel-mode', 'icon');
  // 可见区域要等缩回动画播完再收小：提前收小会把还没缩完的卡片按直线切掉，留下一块背景残影
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (isPanelOpen() && panelMode === 'icon') applyPanelShape();
  }, COLLAPSE_MS);
}

function hidePanel() {
  clearTimeout(hideTimer);
  clearTimeout(showTimer);
  dragPanelAt = 0;
  // 正在退场时又被叫到：什么都不做。不能清掉 leaveTimer，否则窗口永远不销毁、卡在退场状态
  if (!isPanelOpen()) return;
  clearTimeout(leaveTimer);
  const win = panelWin;
  if (!win.isVisible() || !panelReady) return win.destroy();
  panelClosing = true;
  win.setIgnoreMouseEvents(true);       // 退场动画期间不再接鼠标
  win.webContents.send('panel-leave');
  leaveTimer = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, LEAVE_MS);
}

function scheduleHide(delay = 250) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePanel, delay);
}

// 设备列表变了就推给面板（总线推送 + 主动查询都走这里）
function watchDevices() {
  devices.onChange((list) => {
    if (isPanelOpen()) panelWin.webContents.send('devices', list);
  });
}

function startPanelTimers() {
  clearPanelTimers();
  if (!panelBusHeld) { bus.start(); panelBusHeld = true; }
  devices.refresh();                                   // 上一次总线可能已经退回，先查一次
  devices.probe();                                     // 立刻测线路，别等第一个 3 秒节拍
  panelTimers.push(setInterval(() => devices.probe(), PROBE_TICK_MS));
  panelTimers.push(setInterval(() => devices.refresh(), WATCHDOG_MS));
  if (mouse) panelTimers.push(watchOutsideClick());
}

function clearPanelTimers() {
  panelTimers.forEach(clearInterval);
  panelTimers = [];
}

function stopPanelTimers() {
  clearPanelTimers();
  if (panelBusHeld) { bus.stop(); panelBusHeld = false; }
}

// 面板开着时，在面板外按下任意鼠标键就收起。
// 打开面板时如果正按着鼠标（在拖文件），这次按下不算，要等松开后的下一次按下。
function watchOutsideClick() {
  let wasDown = mouse.anyDown();
  return setInterval(() => {
    const down = mouse.anyDown();
    if (down && !wasDown && panelShowing() && !cursorInPanel()) {
      lastOutsideHideAt = Date.now();
      hidePanel();
    }
    wasDown = down;
  }, MOUSE_POLL_MS);
}

// ---------- 感应区 ----------

// 拖拽开始 0.5 秒后，右下角先冒出一个小图标；文件拖到图标上才展开成完整列表。
// 没拖到图标上就松手，图标自己收掉。
function createDragOverlay() {
  dragWatch = createDragWatch({
    onStart() {
      if (isPanelOpen() && panelMode === 'full') return;   // 列表已经开着，直接往上拖就行
      if (isPanelOpen()) hidePanel();      // 上一轮的图标没收干净，先收起
      scheduleShowPanel(DRAG_SHOW_DELAY_MS);
    },
    onEnd() {
      clearTimeout(showTimer);
      if (!isPanelOpen()) return;
      if (panelMode === 'icon') return scheduleHide(120);
      if (dragPanelAt && Date.now() - dragPanelAt >= 300) scheduleHide(260);
    },
  });
  if (dragWatch) dragWatch.start();
}

// ---------- IPC ----------

ipcMain.handle('file:send', (_e, { files, deviceId }) => {
  dragPanelAt = 0;              // 已经开始发送了，松手不要再把面板收起来
  clearTimeout(hideTimer);
  return sender.enqueue(files, devices.cache.find((d) => d.id === deviceId));
});

// 页面量好卡片高度后调用：更新可点区域；直接打开完整列表时，第一次调用才真正显示
ipcMain.handle('panel:fit', (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win !== panelWin) return;
  panelCardH = clampCardH(height);
  if (panelMode !== 'full') return;
  applyPanelShape();
  if (!win.isVisible()) revealPanel();
});

ipcMain.on('panel:hide', () => hidePanel());

ipcMain.handle('receive:fit', (e, height) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const b = receiveBounds(height);
  const cur = win.getBounds();
  if (cur.height !== b.height || cur.y !== b.y) win.setBounds(b);
  if (!win.isVisible()) {
    win.showInactive();          // 不抢焦点
    fadeReceive(win, 1, FADE_IN_MS);
  }
});

ipcMain.on('receive:hide', () => hideReceive());
ipcMain.on('receive:open-dir', () => {
  openReceiveDir();
  hideReceive();
});

// 文件拖进来了：图标就展开成列表；已经是列表就别再因为松手/离开而收起
ipcMain.on('panel:drag-over', () => {
  dragPanelAt = 0;
  clearTimeout(hideTimer);
  if (panelMode === 'icon') expandPanel(false);
});
// 页面报"拖出去了"不一定是真的：图标展开成列表时，鼠标底下的元素换了一层，浏览器会误报一次。
// 所以过一会儿再看光标是不是真的在面板外面；真拖走了就先缩回图标，等松手再消失。
ipcMain.on('panel:drag-leave', () => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!panelShowing()) return;
    if (cursorInPanel()) return;
    if (dragWatch && dragWatch.isDragging() && panelMode === 'full') return collapsePanel();
    if (!(dragWatch && dragWatch.isDragging())) return hidePanel();
  }, DRAG_LEAVE_HIDE_MS);
});

// ---------- 托盘 ----------

// 开机时要执行的程序和参数。免安装运行时 exe 是 electron.exe，要把项目目录作为参数传进去；
// 打包成安装程序后 args 自然为空。
function autostartTarget() {
  return { exe: process.execPath, args: app.isPackaged ? [] : [path.join(__dirname, '..')] };
}

function readAutostart() {
  const { exe, args } = autostartTarget();
  try { return autostart.isEnabled(exe, args); } catch { return false; }
}

function toggleAutostart(on) {
  const { exe, args } = autostartTarget();
  try {
    autostart.setEnabled(on, exe, args);
  } catch (e) {
    dialog.showErrorBox('开机自启设置失败', String(e && e.message || e));
  }
  tray.setContextMenu(buildTrayMenu());     // 按注册表的真实结果重画对钩
  if (readAutostart() === on) {
    tray.displayBalloon({
      title: 'TailDrop',
      content: on ? '已开启开机自启' : '已关闭开机自启',
      iconType: 'info',
      noSound: true,
    });
  }
}

function buildTrayMenu() {
  const on = readAutostart();
  return Menu.buildFromTemplate([
    { label: '显示发送面板', click: () => showPanel() },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: on,
      click: () => toggleAutostart(!on),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let img = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img);
  tray.setToolTip('TailDrop — 拖到右下角发送');
  tray.setContextMenu(buildTrayMenu());
  // 调试模式下给自动化测试留个入口（平时不暴露）
  if (process.env.TAILDROP_DEBUG) {
    globalThis.__tdTray = {
      checked: () => buildTrayMenu().items.find((i) => i.label === '开机自启').checked,
      click: () => buildTrayMenu().items.find((i) => i.label === '开机自启').click(),
    };
    globalThis.__tdPanel = {
      show: (mode) => showPanel(mode),
      expand: () => expandPanel(false),
      collapse: () => collapsePanel(),
      hide: () => hidePanel(),
      prepare: () => scheduleShowPanel(DRAG_SHOW_DELAY_MS),
      prewarm: () => { if (panelAlive() && panelClosing) panelWin.destroy(); if (!panelAlive()) createPanelWindow('icon', false); },
      reveal: () => revealPanel(),
      ready: () => panelReady,
      win: () => panelWin,
      state: () => ({ mode: panelMode, open: isPanelOpen(), closing: panelClosing, cardH: panelCardH,
        visible: panelAlive() && panelWin.isVisible(), rect: panelAlive() ? panelScreenRect() : null,
        frame: panelFrame() }),
    };
  }
  // 左键点托盘：开着就关，关着就开
  tray.on('click', () => {
    if (isPanelOpen()) return hidePanel();
    if (Date.now() - lastOutsideHideAt < TRAY_TOGGLE_MS) return;
    showPanel();
  });
}

// ---------- 生命周期 ----------

// 只允许一个实例：第二次启动时把已有实例的面板叫出来，自己退出
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.zonex.taildrop');
  if (!initTailscale()) {
    dialog.showErrorBox('没找到 Tailscale',
      'TailDrop 需要先安装 Tailscale（tailscale.com/download），装好后再打开这个程序。');
    app.quit();
    return;
  }
  createTray();
  createDragOverlay();
  watchDevices();
  devices.refresh();
  // 常驻监听接收：面板关着也要知道别人正在往这台电脑发文件，
  // 所以总线在这里就启动，且整个进程生命周期内不释放（引用计数始终 ≥1）。
  bus.start();
  receiver.start();
  // 调试用：带 --show 启动时自动弹一次面板，方便检查界面
  if (process.argv.includes('--show')) setTimeout(showPanel, 1200);
  // 开发验证用：模拟一次接收，正常启动不会走到这里
  if (process.env.TAILDROP_TEST_RECEIVE === '1') require('./devtest').run(onReceiveEvent);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  if (tray) tray.destroy();
});
