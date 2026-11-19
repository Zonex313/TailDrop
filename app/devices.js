// 设备列表 + 线路探测（局域网直连 / 公网直连 / 经中转）
//
// 数据来源有两路：
//   1. 消息总线（bus.js）：设备上下线、线路变化会主动推过来。面板一打开就有一条带全网设备
//      的初始消息，所以弹出时不用再启动 tailscale.exe。
//   2. `tailscale status --json`：总线上说明"有变化"之后，拉一次完整状态（每次变化只拉一次）。
//
// 线路怎么判：status 里的 CurAddr 在没流量时可能是空的，所以还要 ping。
// ping 本身会触发打洞，返回的 "via ..." 是此刻真实走的线路。
//
// 注意：闲置一段时间后，Tailscale 会真的退回中转（UDP 打洞的端口映射过期了，没流量就不重打）。
// 这时第一发 ping 走 DERP，但它同时会在后台重打洞，紧接着就变成直连。
// 所以一次 ping 发 4 个，看最后一条结果（tailscale ping 会一直打到直连为止）；
// 再配合"刚测出中转时 2 秒后补测一次"，标签就不会卡在"经中转"。

const { execFile } = require('child_process');

const PING_FRESH_MS = 20000;      // ping 结果在这段时间内优先于 status
const RETRY_SOON_MS = 2000;       // 刚测出中转：2 秒后再测（Tailscale 通常这时已经打通了）
const RETRY_SOON_TRIES = 3;       // 这样连测几次还不行，才按下面的低频重试
const RETRY_RELAY_MS = 15000;     // 确认走不通：15 秒重测一次
const RECHECK_DIRECT_MS = 30000;  // 已知直连：30 秒抽测一次（顺便给打洞续命，线路退回中转能及时纠正）
const PING_TIMEOUT = '2s';

function createDeviceSource(tailscaleExe, bus) {
  const pingResults = new Map();   // id -> { link, at }
  const pingInflight = new Set();
  const listeners = new Set();
  let cache = [];
  let selfAddr = '';               // 本机的 Tailscale IPv4（100.x）
  let refreshTimer = null;
  let refreshing = false;
  let refreshAgain = false;        // 查询进行中又有变化：这次查完马上补查一次

  function run(args, timeout = 8000) {
    return new Promise((resolve) => {
      // ping 走中转时退出码非 0，但输出依然有用，所以这里不区分成功失败
      execFile(tailscaleExe, args, { timeout, windowsHide: true }, (err, stdout) => {
        resolve({ ok: !err, stdout: stdout || '' });
      });
    });
  }

  // 把 status 里的 Peer 表转成面板要的列表
  function apply(status) {
    const now = Date.now();
    // 退出账号 / 断开时 Self 没有地址：清空，让通知服务关掉旧地址上的监听
    selfAddr = ((status.Self && status.Self.TailscaleIPs) || []).find((ip) => !ip.includes(':')) || '';
    cache = Object.values(status.Peer || {})
      .filter((p) => p.Online)                          // 离线设备不显示
      .map((p) => {
        const curAddr = p.CurAddr || '';
        const pinged = pingResults.get(p.ID);
        const fresh = pinged && now - pinged.at < PING_FRESH_MS;
        // confirmed=false 表示"还没测出来"（CurAddr 空、也没 ping 过），界面别写成经中转骗人
        const link = fresh
          ? { ...pinged.link, confirmed: true }
          : { ...linkFromAddr(curAddr, p.Relay), confirmed: !!curAddr };
        return {
          id: p.ID,
          name: p.HostName,
          dnsName: (p.DNSName || '').replace(/\.$/, ''),
          os: p.OS,
          addr: (p.TailscaleIPs || []).find((ip) => !ip.includes(':')) || '',
          curAddr,
          link,
        };
      });
    notify();
  }

  // 总线上"有变化"的消息类型；进度类（OutgoingFiles 等）不在这里处理
  function onMessage(msg) {
    if (msg.InitialStatus) { apply(msg.InitialStatus); return; }
    if (msg.PeersChanged || msg.PeersRemoved || msg.PeerChangedPatch) { scheduleRefresh(); return; }
    // 本机自己的变化（退出 / 登录账号、断开连接、换了地址）：同样重查，通知服务才能跟着关掉或换地址
    if (msg.State != null || msg.LoginFinished || msg.Prefs) scheduleRefresh();
  }

  // 一次变化往往连发好几条，合成一次查询
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 300);
  }

  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    refreshAgain = false;
    try {
      const { ok, stdout } = await run(['status', '--json']);
      if (!ok) return;
      let data;
      try { data = JSON.parse(stdout); } catch { return; }
      apply(data);
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  // 只 ping 线路还没确定或正在走中转的设备
  async function probe() {
    const now = Date.now();
    const targets = cache.filter((d) => {
      if (!d.addr || pingInflight.has(d.id)) return false;
      const known = pingResults.get(d.id);
      const kind = known ? known.link.kind : d.link.kind;
      // 线路未知：马上测；刚测出中转：先快速连测几次；打不通的中转：低频重测；直连：低频抽测
      const wait = !known ? 0
        : kind !== 'relay' ? RECHECK_DIRECT_MS
        : (known.tries || 0) < RETRY_SOON_TRIES ? RETRY_SOON_MS
        : RETRY_RELAY_MS;
      return now - (known ? known.at : 0) >= wait;
    });
    if (!targets.length) return;
    await Promise.all(targets.map(async (d) => {
      pingInflight.add(d.id);
      try {
        // -c 4：允许它在中转之后继续打洞，输出里先 DERP、后直连，最后一条才是当前线路
        const { stdout } = await run(['ping', '-c', '4', '--timeout', PING_TIMEOUT, d.addr], 8000);
        const link = linkFromPing(stdout);
        if (link) {
          const prev = pingResults.get(d.id);
          const tries = link.kind === 'relay' ? ((prev && prev.link.kind === 'relay' ? prev.tries : 0) || 0) + 1 : 0;
          pingResults.set(d.id, { link, at: Date.now(), tries });
        }
      } finally {
        pingInflight.delete(d.id);
      }
    }));
    // 结果写回列表（线路标签要跟着变）
    const now2 = Date.now();
    cache = cache.map((d) => {
      const p = pingResults.get(d.id);
      return p && now2 - p.at < PING_FRESH_MS ? { ...d, link: { ...p.link, confirmed: true } } : d;
    });
    notify();
  }

  function notify() {
    const list = cache.slice();
    for (const fn of listeners) fn(list);
  }

  if (bus) bus.subscribe(onMessage);

  return {
    refresh,
    probe,
    get cache() { return cache; },
    get selfAddr() { return selfAddr; },
    // 面板打开时会调用一次，拿当前快照
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// "pong from phone (100.x) via DERP(hkg) in 500ms" / "via 192.168.0.5:41641 in 4ms"
// 一次 ping 可能有多行（先中转、后直连），取最后一行 = 此刻真实在走的线路
function linkFromPing(out) {
  const all = [...out.matchAll(/via (\S+) in /g)];
  if (!all.length) return null;
  const addr = all[all.length - 1][1];
  const derp = /^DERP\((\w+)\)$/.exec(addr);
  if (derp) return { kind: 'relay', region: derp[1] };
  return { kind: isLanAddr(addr) ? 'lan' : 'p2p' };
}

function linkFromAddr(curAddr, relay) {
  if (!curAddr) return { kind: 'relay', region: relay || '' };
  return { kind: isLanAddr(curAddr) ? 'lan' : 'p2p' };
}

// 判断 "ip:port" / "[ipv6]:port" 是否为局域网地址
function isLanAddr(hostPort) {
  const host = hostPort.startsWith('[')
    ? hostPort.slice(1, hostPort.indexOf(']'))
    : hostPort.replace(/:\d+$/, '');
  if (host.includes(':')) {
    const h = host.toLowerCase();
    return h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  }
  const [a, b] = host.split('.').map(Number);
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

module.exports = { createDeviceSource, isLanAddr, linkFromPing };
