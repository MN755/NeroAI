// Run on a disposable Windows runner after `npm run build`.
// The actual packaged app starts its bundled backend sources with our test venv.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(read, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error('Packaged application did not become ready', { cause: lastError });
}

async function main() {
  assert.equal(process.platform, 'win32');
  const root = path.resolve(__dirname, '..');
  const exe = path.join(root, 'apps/desktop/release/win-unpacked/NeroAI.exe');
  assert.ok(fs.existsSync(exe), 'Packaged executable missing');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neroai-smoke-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env,
    NEROAI_BACKEND_PYTHON: path.join(root, 'apps/backend/.venv/Scripts/python.exe') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`],
    { cwd: path.dirname(exe), env, stdio: 'inherit' });
  let launchError;
  child.on('error', error => { launchError = error; });
  let socket;
  try {
    await waitFor(async () => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, 'Packaged app exited early');
      return (await fetch('http://127.0.0.1:8000/api/v1/health',
        { signal: AbortSignal.timeout(2000) })).ok;
    });
    const target = await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(2000) })).json();
      return targets.find(t => t.type === 'page' && t.url.startsWith('file:')
        && t.url.endsWith('/dist/index.html'));
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Renderer smoke timed out')), 20_000);
      socket.addEventListener('message', ({ data }) => {
        const reply = JSON.parse(data);
        if (reply.id !== 1) return;
        clearTimeout(timeout);
        if (reply.error || reply.result.exceptionDetails) reject(new Error(JSON.stringify(reply)));
        else resolve(reply.result.result.value);
      });
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => {
        for (let i=0; i<100 && !document.querySelector('#root')?.children.length; i++)
          await new Promise(resolve => setTimeout(resolve, 100));
        return { ready: document.readyState, mounted: !!document.querySelector('#root')?.children.length,
          appName: window.neroMeta?.appName, nodeRequire: typeof require,
          hotkey: await window.neroDesktop.getThinkBoxHotkeyStatus() };
      })()`, awaitPromise: true, returnByValue: true } }));
    const state = await result;
    assert.equal(state.ready, 'complete');
    assert.equal(state.mounted, true, 'React renderer did not mount');
    assert.equal(state.appName, 'NeroAI', 'Context bridge preload failed');
    assert.equal(state.nodeRequire, 'undefined', 'Renderer unexpectedly has Node access');
    assert.ok(state.hotkey && typeof state.hotkey === 'object', 'Main-process IPC failed');
    console.log('Packaged Windows app: backend health, renderer, context bridge and IPC passed.');
  } finally {
    if (socket) socket.close();
    if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
