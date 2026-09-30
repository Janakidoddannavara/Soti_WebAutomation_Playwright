const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { CONFIG } = require('../config/config');
const { state } = require('./state');
const { ensureDir } = require('../utils/helpers');

async function waitForCdp(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Chrome CDP not ready on port ${port}`);
}

/** Wait until nothing is listening on the debug port (so the next Chrome can bind). */
async function waitForPortFree(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          reject(new Error(`still open (${res.statusCode})`));
        });
        req.on('error', () => resolve()); // ECONNREFUSED = free
        req.setTimeout(800, () => {
          req.destroy();
          resolve();
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  // Last resort: force-kill again
  killPortListeners(port);
  await new Promise((r) => setTimeout(r, 1000));
}

function killPortListeners(port) {
  try {
    execSync(`lsof -ti tcp:${port} 2>/dev/null | xargs kill -9 2>/dev/null || true`, {
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }
}

async function connectCdp(port) {
  state.cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = state.cdpBrowser.contexts()[0] || (await state.cdpBrowser.newContext());
  let page = context.pages().find((p) => p && !p.isClosed()) || (await context.newPage());
  try {
    await page.waitForTimeout(800);
  } catch {
    page = context.pages().find((p) => p && !p.isClosed()) || (await context.newPage());
  }
  return { context, page };
}

async function launchOsChrome() {
  const port = CONFIG.chromeDebugPort || 9222;
  const userDataDir =
    CONFIG.osChromeUserDataDir ||
    path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome');
  const profile = CONFIG.osChromeProfileDirectory || 'Default';

  try {
    await waitForCdp(port, 1500);
    state.attachedToExistingChrome = true;
    console.log(
      `Browser mode: os-chrome — attached to Chrome already on port ${port} (reuses Sumo session).`
    );
    const { context, page } = await connectCdp(port);
    return { context, page, mode: 'os-chrome' };
  } catch {
    // Chrome is not listening on the debug port
  }

  const lockFile = path.join(userDataDir, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    throw new Error(
      'Your normal Chrome is already open, so automation cannot reuse that Sumo login.\n' +
        'Quit Google Chrome completely, then run: npm run receipt-logs\n' +
        'Or start Chrome with debugging and re-run:\n' +
        `  "${CONFIG.chromePath}" --remote-debugging-port=${port}`
    );
  }

  if (!fs.existsSync(CONFIG.chromePath)) {
    throw new Error(`Chrome not found at ${CONFIG.chromePath}`);
  }

  console.log('Browser mode: os-chrome — launching your real Chrome profile (Sumo cookies reused)...');
  state.chromeProcess = spawn(
    CONFIG.chromePath,
    [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--profile-directory=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ],
    { stdio: 'ignore', detached: true }
  );
  state.chromeProcess.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
  });
  state.chromeProcess.on('exit', (code, signal) => {
    console.warn(`Chrome process exited (code=${code}, signal=${signal}).`);
  });

  await waitForCdp(port, 60000);
  const { context, page } = await connectCdp(port);
  return { context, page, mode: 'os-chrome' };
}

function receiptLookupUserDataDir() {
  // Isolate batch profiles so Chrome profile locks/corruption don't kill later scenarios.
  if (CONFIG.batchMode && CONFIG.activeScenario) {
    const safe = String(CONFIG.activeScenario).replace(/[^\w.-]+/g, '_');
    return path.join(process.cwd(), `user-data-receipt-lookup-${safe}`);
  }
  return path.join(process.cwd(), 'user-data-receipt-lookup');
}

function clearProfileLocks(userDataDir) {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(userDataDir, f));
    } catch {
      // ignore
    }
  }
}

async function launchChromeCdpOnce() {
  const userDataDir = receiptLookupUserDataDir();
  ensureDir(userDataDir);
  clearProfileLocks(userDataDir);

  for (const rel of ['Default/Extensions', 'Default/Local Extension Settings']) {
    try {
      fs.rmSync(path.join(userDataDir, rel), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (!fs.existsSync(CONFIG.chromePath)) {
    throw new Error(`Chrome not found at ${CONFIG.chromePath}`);
  }

  const extPath = path.resolve(CONFIG.extensionPath);
  if (!fs.existsSync(extPath)) {
    console.warn(`Extension not found at ${extPath} — using inject-only context.`);
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: CONFIG.headless,
      viewport: null,
      args: ['--start-maximized'],
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    const page = context.pages()[0] || (await context.newPage());
    return { context, page, mode: 'inject' };
  }

  const port = CONFIG.chromeDebugPort || 9222;
  await waitForPortFree(port, 15000);

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    'about:blank',
  ];

  state.chromeProcess = spawn(CONFIG.chromePath, args, {
    stdio: 'ignore',
    detached: false,
  });
  state.chromeProcess.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
  });

  await waitForCdp(port, 45000);
  const { context, page } = await connectCdp(port);

  for (let i = 0; i < 10; i++) {
    const workers = context.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'));
    if (workers.length) {
      console.log(`Service workers: ${workers.map((w) => w.url()).join(', ')}`);
      return { context, page, mode: 'chrome-cdp' };
    }
    await page.waitForTimeout(500);
  }

  console.log('Service workers: (none yet — will try inject fallback)');
  return { context, page, mode: 'chrome-cdp' };
}

async function launchBrowserWithExtensions() {
  // Batch mode cannot reliably reuse the user's personal Chrome profile.
  if (CONFIG.batchMode && CONFIG.browserMode === 'os-chrome') {
    console.log('Batch mode: overriding browserMode os-chrome → chrome-cdp');
    CONFIG.browserMode = 'chrome-cdp';
  }

  if (CONFIG.browserMode === 'os-chrome') {
    return launchOsChrome();
  }

  const userDataDir = receiptLookupUserDataDir();
  ensureDir(userDataDir);

  if (CONFIG.browserMode === 'inject') {
    console.log('Browser mode: inject (no extension UI — token injected like extension Config).');
    clearProfileLocks(userDataDir);
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: CONFIG.headless,
      viewport: null,
      args: ['--start-maximized'],
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    const page = context.pages()[0] || (await context.newPage());
    return { context, page, mode: 'inject' };
  }

  console.log('Browser mode: chrome-cdp (Chrome + Kmart Device Emulator extension)...');

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        await cleanupBrowser({ forceKillPort: true, settleMs: 4000 });
      } else {
        const port = CONFIG.chromeDebugPort || 9222;
        await waitForPortFree(port, 15000).catch(() => {});
      }
      return await launchChromeCdpOnce();
    } catch (err) {
      lastErr = err;
      console.warn(`Chrome CDP launch attempt ${attempt}/3 failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('Chrome CDP launch failed');
}

function stopChromeProcess() {
  if (state.chromeProcess && !state.chromeProcess.killed) {
    try {
      state.chromeProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    try {
      state.chromeProcess.kill('SIGKILL');
    } catch {
      // ignore
    }
    state.chromeProcess = null;
  }
}

/** Close CDP + kill Chrome and wait so the next scenario can bind port 9222. */
async function cleanupBrowser({ forceKillPort = true, settleMs = 2000 } = {}) {
  try {
    if (state.cdpBrowser) {
      await state.cdpBrowser.close().catch(() => {});
      state.cdpBrowser = null;
    }
  } catch {
    // ignore
  }

  stopChromeProcess();
  state.attachedToExistingChrome = false;

  if (forceKillPort) {
    const port = CONFIG.chromeDebugPort || 9222;
    killPortListeners(port);
    await waitForPortFree(port, 12000).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, settleMs));
}

module.exports = {
  waitForCdp,
  waitForPortFree,
  connectCdp,
  launchOsChrome,
  launchBrowserWithExtensions,
  stopChromeProcess,
  cleanupBrowser,
};
