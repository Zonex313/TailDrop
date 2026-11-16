// 仅用于开发验证：模拟一次"别人往这台电脑发文件"的完整过程。
// 只有设置了环境变量 TAILDROP_TEST_RECEIVE=1 才会被加载，正常启动完全不参与。
//
// 用法：set TAILDROP_TEST_RECEIVE=1 后启动，右下角会出现一条假接收进度，约 10 秒后自动收起。

const TOTAL = 24 * 1024 * 1024;
const TICK_MS = 800;
const STEPS = 10;

function run(emit) {
  const peer = { id: 'test', name: 'Pixel 8', os: 'android', link: { kind: 'lan' } };
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const received = Math.round((TOTAL * step) / STEPS);
    const done = step >= STEPS;
    emit([{
      name: '测试接收.mp4',
      size: TOTAL,
      received,
      pct: done ? 1 : received / TOTAL,
      speed: done ? 0 : TOTAL / STEPS / (TICK_MS / 1000),
      done,
      peer,
    }]);
    if (done) {
      clearInterval(timer);
      setTimeout(() => emit([]), 2600);
    }
  }, TICK_MS);
}

module.exports = { run };
