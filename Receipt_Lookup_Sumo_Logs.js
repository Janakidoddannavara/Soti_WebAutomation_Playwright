process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
});

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// Load .env into process.env (no dotenv dependency)
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

let localAuthServerProcess = null;
let chromeProcess = null;
let cdpBrowser = null;
let attachedToExistingChrome = false;

// ─── Configuration ───────────────────────────────────────────────────────────
// Fill in search details below, then run: npm run receipt-logs

const CONFIG = {
  receiptLookupUrl: 'https://ui-pdt-receipt-lookup.prod.dsf-cs-prod.a-kmtkmg.net/',

  // Search mode:
  //   'byDetails'               → Store + dates + amount + Card/Flybuys/OnePass
  //   'byDigitalReceiptNumber'  → Digital Receipt Number only (22 digits)
  searchMode: 'byDetails',

  // Used when searchMode = 'byDetails'
  byDetails: {
    storeNameOrNumber: '1002', // Store Number or Name
    startDate: '12/07/2026', // 12 July 2026 (DD/MM/YYYY) — pick from calendar only
    endDate: '16/07/2026', // 16 July 2026 = 5-day inclusive window (12→16) — calendar click only
    amountFrom: '40.00',
    amountTo: '45.00',
    // Identify by: 'card' | 'flybuys' | 'onepass'
    identifyBy: 'card',
    cardLastThree: '789', // exactly 3 digits
    flybuysId: '', // exactly 13 digits when identifyBy = flybuys
    onepassId: '', // exactly 13 digits when identifyBy = onepass
  },

  // Used when searchMode = 'byDigitalReceiptNumber'
  digitalReceiptNumber: '', // exactly 22 digits

  // Extra seconds after a receipt is open (Sumo ingest). Results wait on UI, not this.
  waitAfterSearchSeconds: 2,
  // Keep opened receipt visible this many seconds before clicking New Search
  receiptViewSeconds: 10,

  // Local PDT auth site — Sign in here first; token is captured from Network (same as Inspect → Network → token)
  // Token rotates about every 1 hour — script ALWAYS fetches a fresh token on each run (never reused from disk).
  localAuthUrl: 'http://localhost:7575/',
  localAuthAccount: 'janaki.doddannavara@anko.com',
  // Auto-start the MSAL sample server if 7575 is down (you normally just open the page in Chrome)
  localAuthServerDir: path.join(
    process.env.HOME || '',
    'Documents/ms-identity-javascript-v2-master'
  ),
  autoStartLocalAuthServer: true,
  // Refresh again if token will expire within this many minutes
  tokenRefreshSkewMinutes: 5,

  // Browser strategy:
  //   'os-chrome'   — reuse YOUR Chrome profile (Sumo already logged in). Quit Chrome first.
  //   'chrome-cdp'  — isolated profile + load extension (Kmart SSO fails with AADSTS50105)
  //   'inject'      — skip extension UI; inject token the same way the extension Config message does
  browserMode: 'chrome-cdp',
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromeDebugPort: 9222,
  osChromeUserDataDir: path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome'),
  osChromeProfileDirectory: 'Default',

  // Kmart Device Emulator Chrome extension — paste Auth Token here, then reload Receipt Lookup
  extensionPath: path.join(
    process.env.HOME || '',
    'Documents/GitHub/kmart-device-emulator-chrome-extension/extension'
  ),
  // Installed extension id from chrome://extensions (used when connecting to your normal Chrome)
  extensionId: 'jagfjolngdgfmjfcaamnpmpfbpbkfkea',
  // Device store id in the extension popup (separate from Receipt Lookup search store)
  extensionStoreId: '1907',
  // Store server shown in your extension popup
  extensionStoreServer: 'https://kv1907na001.core.kmtltd.net.au',

  // Step toggles
  runLocalAuth: true, // launch localhost:7575 and fetch Network token
  runExtensionPaste: true, // paste token into Kmart Device Emulator Auth Token field
  runReceiptLookup: true, // open Receipt Lookup and run search scenario

  // Set true after receipt search to open Sumo and run the error query
  runSumoCheck: true,

  // Sumo Logic — https://kmartgroup.au.sumologic.com/ui/#/search/29f3ef3f_768f_b52c_4b03_14bf0b793d3e
  sumoSearchUrl:
    'https://kmartgroup.au.sumologic.com/ui/#/search/29f3ef3f_768f_b52c_4b03_14bf0b793d3e',
  // Prefer .env (SUMO_EMAIL / SUMO_PASSWORD) so credentials are not committed
  sumoEmail: process.env.SUMO_EMAIL || 'janaki.doddannavara@anko.com',
  sumoPassword: process.env.SUMO_PASSWORD || '',
  // User's Sumo query (do not re-paste if already in the search box)
  // Exclude HttpRequestLogger noise; ReceiptService holds "Found N receipt(s)" for UI compare.
  sumoQuery: `(_collector="dsf-cs-receiptlookup") and (_sourceCategory="dsfcs/prod/aws/ecs/api") | where Context != "HttpRequestLogger" | where Context = "ReceiptService"`,


  // Environment: prod | uat | dev
  env: 'prod',
  // Service layer: 'api' | 'bff' | 'api/bff'
  serviceLayer: 'api',

  outputDir: path.join(process.cwd(), 'output'),
  headless: false,
  // Keep browser open after run so you can review results
  keepOpenSeconds: 20,
  // How long to wait for localhost:7575 to become available (ms)
  localAuthWaitMs: 180000,
};

// ─── Sumo Logic query (as provided) ──────────────────────────────────────────

function buildSumoQuery(env, serviceLayer) {
  const category =
    serviceLayer === 'api/bff'
      ? `dsfcs/${env}/aws/ecs/(api/bff)`
      : `dsfcs/${env}/aws/ecs/${serviceLayer}`;

  return `(_collector="dsf-cs-receiptlookup") and (_sourceCategory="${category}")`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function screenshot(page, name) {
  ensureDir(CONFIG.outputDir);
  const filePath = path.join(CONFIG.outputDir, `${timestamp()}_${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`Screenshot saved: ${filePath}`);
  return filePath;
}

async function fillVisibleInput(locator, value) {
  await locator.click({ clickCount: 3 });
  await locator.fill(String(value));
}

function extractTokenFromBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return null;
    try {
      return extractTokenFromBody(JSON.parse(trimmed));
    } catch {
      // Raw JWT or plain token string
      return trimmed.replace(/^Bearer\s+/i, '');
    }
  }
  if (typeof body !== 'object') return null;

  const direct =
    body.apiAuthToken ||
    body.access_token ||
    body.accessToken ||
    body.id_token ||
    body.idToken ||
    body.token ||
    body.value;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.replace(/^Bearer\s+/i, '').trim();
  }
  if (body.data) return extractTokenFromBody(body.data);
  if (body.payload) return extractTokenFromBody(body.payload);
  if (body.result) return extractTokenFromBody(body.result);
  return null;
}

function getJwtExpiryMs(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp) return null;
    return Number(payload.exp) * 1000;
  } catch {
    try {
      const parts = String(token).split('.');
      const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(json);
      return payload.exp ? Number(payload.exp) * 1000 : null;
    } catch {
      return null;
    }
  }
}

function isTokenFresh(token, skewMinutes = CONFIG.tokenRefreshSkewMinutes) {
  if (!token) return false;
  const expMs = getJwtExpiryMs(token);
  if (!expMs) {
    // Non-JWT token — treat as fresh for this run only (never persisted)
    return true;
  }
  const skewMs = (skewMinutes || 5) * 60 * 1000;
  return Date.now() < expMs - skewMs;
}

function isTokenRequest(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    // MSAL / Azure AD token endpoint (Inspect → Network → "token")
    if (path.includes('/oauth2/v2.0/token') || path.includes('/oauth2/token')) return true;
    if (parsed.hostname.includes('login.microsoftonline.com') && path.includes('token')) return true;
    return (
      path.includes('/token') ||
      /(^|[?&])token([=&]|$)/i.test(path) ||
      parsed.pathname.split('/').pop() === 'token'
    );
  } catch {
    return /token/i.test(url);
  }
}

async function selectLocalAuthAccount(page) {
  const account = CONFIG.localAuthAccount;
  const accountBtn = page
    .getByRole('button', { name: new RegExp(account, 'i') })
    .or(page.getByText(account, { exact: false }))
    .or(page.locator(`[data-email="${account}"], [data-identifier="${account}"]`));

  if (await accountBtn.first().isVisible({ timeout: 8000 }).catch(() => false)) {
    await accountBtn.first().click();
    console.log(`Selected account: ${account}`);
    return true;
  }
  return false;
}

async function clickSignIn(page) {
  const signIn = page
    .getByRole('button', { name: /sign in|log in|login/i })
    .or(page.getByRole('link', { name: /sign in|log in|login/i }))
    .or(page.locator('button, a').filter({ hasText: /sign in/i }));

  if (await signIn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await signIn.first().click();
    console.log('Clicked Sign in.');
    return true;
  }
  console.log('Sign in button not shown — may already be signed in.');
  return false;
}

async function clickSeeProfile(page) {
  const btn = page.getByRole('button', { name: /See Profile/i });
  if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btn.click();
    console.log('Clicked See Profile (triggers Network token request).');
    return true;
  }
  return false;
}

async function attachTokenCapture(page, tokenBox, { keepLatest = true } = {}) {
  // Same as Inspect → Network → token → Preview → access_token
  const onResponse = async (response) => {
    const url = response.url();
    if (!isTokenRequest(url)) return;

    let body = null;
    try {
      body = await response.json();
    } catch {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }
    // Prefer access_token exactly like the DevTools Preview JSON
    const token =
      (body && typeof body === 'object' && body.access_token) ||
      extractTokenFromBody(body);
    if (!token || typeof token !== 'string') return;
    if (!keepLatest && tokenBox.value) return;

    tokenBox.value = token;
    tokenBox.capturedAt = Date.now();
    tokenBox.expiresAt = getJwtExpiryMs(token);
    const expiresIn = body && body.expires_in ? Number(body.expires_in) : null;
    if (expiresIn) {
      tokenBox.expiresAt = Date.now() + expiresIn * 1000;
    }

    const mins = tokenBox.expiresAt
      ? Math.round((tokenBox.expiresAt - Date.now()) / 60000)
      : null;
    console.log(
      mins != null
        ? `Captured access_token from Network "token" (${token.length} chars, ~${mins} min left).`
        : `Captured access_token from Network "token" (${token.length} chars).`
    );
  };

  page.on('response', onResponse);
  return () => page.off('response', onResponse);
}

async function waitForToken(tokenBox, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!tokenBox.value && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
  }
  return !!tokenBox.value;
}

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

async function connectCdp(port) {
  cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = cdpBrowser.contexts()[0] || (await cdpBrowser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  await page.waitForTimeout(1000);
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
    attachedToExistingChrome = true;
    console.log(`Browser mode: os-chrome — attached to Chrome already on port ${port} (reuses Sumo session).`);
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
  // Do not set --user-data-dir to the default Chrome path — on macOS the launcher
  // exits and the real browser comes up without the debug port.
  chromeProcess = spawn(
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
  chromeProcess.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
  });
  chromeProcess.on('exit', (code, signal) => {
    console.warn(`Chrome process exited (code=${code}, signal=${signal}).`);
  });

  await waitForCdp(port, 60000);
  const { context, page } = await connectCdp(port);
  return { context, page, mode: 'os-chrome' };
}

async function launchBrowserWithExtensions() {
  if (CONFIG.browserMode === 'os-chrome') {
    return launchOsChrome();
  }

  const userDataDir = path.join(process.cwd(), 'user-data-sumo');
  ensureDir(userDataDir);

  if (CONFIG.browserMode === 'inject') {
    console.log('Browser mode: inject (no extension UI — token injected like extension Config).');
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

  // Isolated profile — Kmart SSO to Sumo hits AADSTS50105 for unassigned users
  console.log('Browser mode: chrome-cdp (isolated profile + extension via remote debugging)...');
  if (!fs.existsSync(CONFIG.chromePath)) {
    throw new Error(`Chrome not found at ${CONFIG.chromePath}`);
  }

  const port = CONFIG.chromeDebugPort || 9222;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    `--disable-extensions-except=${CONFIG.extensionPath}`,
    `--load-extension=${CONFIG.extensionPath}`,
    'about:blank',
  ];

  chromeProcess = spawn(CONFIG.chromePath, args, {
    stdio: 'ignore',
    detached: false,
  });
  chromeProcess.on('error', (err) => {
    console.error('Failed to launch Chrome:', err.message);
  });

  await waitForCdp(port);
  const { context, page } = await connectCdp(port);

  const workers = context.serviceWorkers().map((w) => w.url());
  console.log(`Service workers: ${workers.join(', ') || '(none yet — will try inject fallback)'}`);

  return { context, page, mode: 'chrome-cdp' };
}

async function getExtensionId(context) {
  let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!worker) {
    console.log('Waiting for Kmart Device Emulator service worker...');
    worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  }
  const extensionId = worker.url().split('/')[2];
  if (!extensionId) throw new Error('Could not resolve extension id');
  console.log(`Loaded extension id: ${extensionId}`);
  return extensionId;
}

async function pasteTokenIntoExtension(context, token, storeId) {
  console.log('\n[2/4] Updating Auth Token in Kmart Device Emulator extension...');
  const storeValue = String(storeId || CONFIG.extensionStoreId || '');

  let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!worker) {
    try {
      worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    } catch {
      throw new Error('EXTENSION_NOT_AVAILABLE');
    }
  }

  await worker.evaluate(
    async ({ tokenValue, storeValue, storeServer }) => {
      const data = {
        kmartDeviceAuthToken: tokenValue,
        kmartDeviceStoreId: storeValue,
      };
      if (storeServer) data.kmartDeviceStoreServer = storeServer;
      await chrome.storage.local.set(data);
    },
    {
      tokenValue: token,
      storeValue,
      storeServer: CONFIG.extensionStoreServer || '',
    }
  );

  const saved = await worker.evaluate(async () => {
    return await chrome.storage.local.get([
      'kmartDeviceAuthToken',
      'kmartDeviceStoreId',
      'kmartDeviceStoreServer',
    ]);
  });

  const tokenLen = (saved.kmartDeviceAuthToken || '').length;
  if (!tokenLen) throw new Error('Auth Token was not saved into extension storage');

  console.log(
    `Extension Auth Token updated (${tokenLen} chars), Store Id "${saved.kmartDeviceStoreId || ''}"`
  );

  try {
    const extensionId = await getExtensionId(context);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await popup.waitForTimeout(800);
    await screenshot(popup, 'extension_token_pasted');
    await popup.close();
  } catch (err) {
    console.warn('Could not open extension popup for screenshot:', err.message);
  }
}

// Fallback when extension cannot be loaded — same Config payload the extension sends
async function injectTokenLikeExtension(page, token, storeId) {
  console.log('\n[2/4] Extension not available — injecting token like extension Config message...');
  const storeValue = String(storeId || CONFIG.extensionStoreId || '');

  await page.routeWebSocket(/localhost:7555/, (ws) => {
    const sendConfig = () => {
      ws.send(
        JSON.stringify({
          className: 'Config',
          payload: {
            storeServerUrl: CONFIG.extensionStoreServer || '',
            apiAuthToken: token,
            token,
            storeId: storeValue,
            teamMemberId: '',
            firstName: 'Alex',
            lastName: 'Bailey',
          },
        })
      );
    };
    ws.onMessage((message) => {
      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : null;
        if (parsed && (parsed.className === 'Connect' || parsed.ClassName === 'Connect')) {
          sendConfig();
        }
      } catch {
        // ignore
      }
    });
    setTimeout(sendConfig, 400);
  });

  console.log('Token inject route ready (ws://localhost:7555 Config).');
}

async function applyToken(context, page, token, mode) {
  if (mode === 'inject') {
    await injectTokenLikeExtension(page, token, CONFIG.extensionStoreId);
    return 'inject';
  }
  try {
    await pasteTokenIntoExtension(context, token, CONFIG.extensionStoreId);
    return 'extension';
  } catch (err) {
    console.warn(`Extension paste failed (${err.message}) — using inject fallback.`);
    await injectTokenLikeExtension(page, token, CONFIG.extensionStoreId);
    return 'inject';
  }
}

function stopChromeProcess() {
  if (chromeProcess && !chromeProcess.killed) {
    try {
      chromeProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    chromeProcess = null;
  }
}

async function openReceiptLookupAndReload(page) {
  return openReceiptLookup(page);
}

// (kept for clarity — openReceiptLookup now always reloads after goto)


async function isLocalAuthReachable() {
  try {
    const res = await fetch(CONFIG.localAuthUrl, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function ensureLocalAuthServer() {
  if (await isLocalAuthReachable()) {
    console.log('localhost:7575 is already running.');
    return;
  }

  if (!CONFIG.autoStartLocalAuthServer) {
    throw new Error(
      'localhost:7575 is not running. Open that page in Chrome first, or set autoStartLocalAuthServer=true.'
    );
  }

  const dir = CONFIG.localAuthServerDir;
  const serverJs = path.join(dir, 'server.js');
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Cannot auto-start token page — server not found at ${serverJs}`
    );
  }

  console.log(`localhost:7575 is down — starting MSAL sample server from:\n  ${dir}`);
  localAuthServerProcess = spawn('node', ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: '7575' },
    stdio: 'ignore',
    detached: false,
  });
  localAuthServerProcess.on('error', (err) => {
    console.error('Failed to start local auth server:', err.message);
  });

  // Give it a moment to bind the port
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isLocalAuthReachable()) {
      console.log('localhost:7575 started automatically.');
      return;
    }
  }

  throw new Error('Started local auth server but localhost:7575 still not reachable.');
}

function stopLocalAuthServer() {
  if (localAuthServerProcess && !localAuthServerProcess.killed) {
    try {
      localAuthServerProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    localAuthServerProcess = null;
  }
}

async function waitForLocalAuthServer(page) {
  await ensureLocalAuthServer();

  const url = CONFIG.localAuthUrl;
  const timeoutMs = CONFIG.localAuthWaitMs || 180000;
  const started = Date.now();
  let attempt = 0;

  console.log(`Opening ${url}...`);

  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 8000,
      });
      if (response || page.url().includes('7575')) {
        console.log(`localhost:7575 page loaded (attempt ${attempt}).`);
        return;
      }
    } catch (err) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(
        `  attempt ${attempt}: not ready yet (${elapsed}s) — ${err.message.split('\n')[0]}`
      );
      await page.waitForTimeout(2000);
    }
  }

  throw new Error(
    `Could not open ${url}. Make sure the token page is available on port 7575.`
  );
}

async function signInAndCaptureToken(page) {
  console.log(`\n[1/4] Opening MSAL local auth (localhost:7575) for access_token...`);
  const tokenBox = { value: null, capturedAt: null, expiresAt: null };
  const detach = await attachTokenCapture(page, tokenBox, { keepLatest: true });

  // Do not quit immediately — wait/retry until localhost:7575 is reachable
  await waitForLocalAuthServer(page); 
  await page.waitForTimeout(1500);

  // Sign in if needed (Microsoft identity platform SPA)
  const alreadyWelcome = await page
    .getByText(/Welcome\s+Janaki\.Doddannavara@anko\.com/i)
    .or(page.getByText(CONFIG.localAuthAccount, { exact: false }))
    .first()
    .isVisible({ timeout: 4000 })
    .catch(() => false);

  if (!alreadyWelcome) {
    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    const clickedSignIn = await clickSignIn(page);
    const popup = clickedSignIn ? await popupPromise : null;
    const loginPage = popup || page;

    if (popup) {
      await attachTokenCapture(popup, tokenBox, { keepLatest: true });
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await selectLocalAuthAccount(loginPage);
    await page
      .getByText(/Welcome/i)
      .first()
      .waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => {});
  } else {
    console.log('Already signed in on localhost:7575.');
  }

  // Wait for Network "token" → access_token (same as Inspect → Network → token)
  await waitForToken(tokenBox, 15000);

  // If no token yet: click blank area (as you do manually), then See Profile to trigger token call
  if (!tokenBox.value) {
    console.log('No token yet — clicking blank page area, then See Profile to trigger Network token...');
    await page.locator('body').click({ position: { x: 500, y: 300 }, force: true }).catch(() => {});
    await page.waitForTimeout(500);

    const tokenWait = page
      .waitForResponse((res) => isTokenRequest(res.url()), { timeout: 30000 })
      .catch(() => null);

    await clickSeeProfile(page);
    const tokenResponse = await tokenWait;
    if (tokenResponse) {
      try {
        const body = await tokenResponse.json();
        if (body?.access_token) {
          tokenBox.value = body.access_token;
          tokenBox.capturedAt = Date.now();
          tokenBox.expiresAt = body.expires_in
            ? Date.now() + Number(body.expires_in) * 1000
            : getJwtExpiryMs(body.access_token);
          console.log(
            `Captured access_token from Network token response (${tokenBox.value.length} chars).`
          );
        }
      } catch {
        // listener may already have captured it
      }
    }
    await waitForToken(tokenBox, 10000);
  }

  // IMPORTANT: do NOT clear a successfully captured token
  if (tokenBox.value && isTokenFresh(tokenBox.value)) {
    console.log('Using captured access_token (same value as Network tab → token → access_token).');
    detach();
    await screenshot(page, 'local_auth_signed_in');
    return tokenBox;
  }

  detach();

  if (!tokenBox.value) {
    throw new Error(
      'Could not capture access_token from localhost:7575 Network "token" request.'
    );
  }

  if (!isTokenFresh(tokenBox.value)) {
    throw new Error(
      'Captured access_token is already expired or near expiry. Sign in again on localhost:7575 and re-run.'
    );
  }

  await screenshot(page, 'local_auth_signed_in');
  return tokenBox;
}

async function refreshTokenIfNeeded(context, tokenHolder) {
  if (isTokenFresh(tokenHolder.value)) {
    console.log('Token still fresh — no refresh needed.');
    return tokenHolder;
  }

  console.log('Token expired / near expiry (hourly rotation) — fetching a new one...');
  const authPage = await context.newPage();
  try {
    const fresh = await signInAndCaptureToken(authPage);
    tokenHolder.value = fresh.value;
    tokenHolder.capturedAt = fresh.capturedAt;
    tokenHolder.expiresAt = fresh.expiresAt;
    await pasteTokenIntoExtension(
      context,
      tokenHolder.value,
      CONFIG.extensionStoreId
    );
    console.log('Token refreshed and re-pasted into extension — reload Receipt Lookup.');
    return tokenHolder;
  } finally {
    await authPage.close().catch(() => {});
  }
}

// ─── Step 3: Receipt Lookup ──────────────────────────────────────────────────

async function openReceiptLookup(page) {
  console.log(`\n[3/4] Opening Receipt Lookup: ${CONFIG.receiptLookupUrl}`);
  await page.goto(CONFIG.receiptLookupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Reload same page so Kmart Device Emulator picks up the updated Auth Token and sends Config
  console.log('Reloading Receipt Lookup page so extension applies the new token...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.locator('#purchaseDate-start').waitFor({ state: 'attached', timeout: 45000 });
  await page.getByRole('button', { name: /^Search$/i }).waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(2000);
  console.log('Receipt Lookup reloaded with updated extension token.');
}

async function selectTab(page, mode) {
  if (mode === 'byDigitalReceiptNumber') {
    await page.getByRole('tab', { name: /By digital receipt number/i }).click();
    console.log('Tab: By digital receipt number');
  } else {
    const byDetails = page.getByRole('tab', { name: /By details/i });
    if (await byDetails.isVisible({ timeout: 2000 }).catch(() => false)) {
      await byDetails.click();
    }
    console.log('Tab: By details');
  }
  await page.waitForTimeout(500);
}

async function typeInto(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await locator.fill('');
  await locator.type(String(value), { delay: 40 });
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseDateParts(dateStr) {
  // DD/MM/YYYY
  const [dd, mm, yyyy] = dateStr.split('/').map((p) => parseInt(p, 10));
  return { day: dd, month: mm, year: yyyy, monthName: MONTH_NAMES[mm - 1] };
}

function formatDdMmYyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/** End date = start + dayDiff. Default 4 → 5-day inclusive range (e.g. 12→16). Calendar only. */
function endDateWithDiff(startDateStr, dayDiff = 4) {
  const { day, month, year } = parseDateParts(startDateStr);
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + dayDiff);
  return formatDdMmYyyy(d);
}

async function openDatePicker(page, groupAriaLabel) {
  const isEnd = /end/i.test(groupAriaLabel);
  const input = page.locator(isEnd ? '#purchaseDate-end' : '#purchaseDate-start');
  await input.waitFor({ state: 'attached', timeout: 15000 });

  // Prefer calendar icon on the SAME field (avoids Start/End picking the same date)
  const formControl = input.locator(
    'xpath=ancestor::*[contains(@class,"MuiFormControl-root") or contains(@class,"MuiStack-root")][1]'
  );
  const chooseBtn = formControl.getByRole('button', { name: /Choose date/i });

  if (await chooseBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await chooseBtn.first().click();
  } else {
    const group = page.locator(`[aria-label="${groupAriaLabel}"]`);
    const groupChoose = group
      .locator('xpath=ancestor::*[contains(@class,"MuiFormControl") or contains(@class,"MuiPickers")][1]')
      .getByRole('button', { name: /Choose date/i });
    if (await groupChoose.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      await groupChoose.first().click();
    } else {
      // Start = 1st Choose date, End = 2nd
      const allChoose = page.getByRole('button', { name: /Choose date/i });
      await allChoose.nth(isEnd ? 1 : 0).click();
    }
  }

  const calendar = page.locator('.MuiPickersLayout-root, .MuiDateCalendar-root, [role="dialog"]').last();
  await calendar.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(400);
}

async function getVisibleCalendarMonthYear(page) {
  const label = page.locator(
    '.MuiPickersCalendarHeader-label, .MuiPickersCalendarHeader-labelContainer button, button[aria-label*="calendar view" i], button[aria-label*="year view" i]'
  ).first();
  const text = ((await label.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  return text;
}

async function navigateCalendarToMonth(page, monthName, year) {
  const target = `${monthName} ${year}`;

  // Prefer switching via year/month views when available
  const switchViewBtn = page
    .getByRole('button', { name: /calendar view is open|year view is open/i })
    .or(page.locator('.MuiPickersCalendarHeader-label, .MuiPickersCalendarHeader-labelContainer button').first());

  if (await switchViewBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await switchViewBtn.first().click();
    await page.waitForTimeout(300);

    // Year button in year grid
    const yearBtn = page.getByRole('radio', { name: String(year) })
      .or(page.getByRole('button', { name: new RegExp(`^${year}$`) }))
      .or(page.locator('.MuiPickersYear-yearButton', { hasText: String(year) }));
    if (await yearBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await yearBtn.first().click();
      await page.waitForTimeout(300);
    }

    // Month button if month view appears
    const monthBtn = page.getByRole('radio', { name: monthName })
      .or(page.getByRole('button', { name: new RegExp(`^${monthName}$|^${monthName.slice(0, 3)}$`, 'i') }))
      .or(page.locator('.MuiPickersMonth-monthButton', { hasText: new RegExp(monthName.slice(0, 3), 'i') }));
    if (await monthBtn.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      await monthBtn.first().click();
      await page.waitForTimeout(300);
    }
  }

  // Arrow navigate until header shows target month/year (max 24 steps)
  for (let i = 0; i < 24; i++) {
    const header = await getVisibleCalendarMonthYear(page);
    if (new RegExp(`${monthName}\\s*${year}`, 'i').test(header) || header.includes(target)) {
      console.log(`Calendar on ${header}`);
      return;
    }

    // Decide direction from parsed header like "September 2026"
    const match = header.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    let goPrev = true;
    if (match) {
      const curMonth = MONTH_NAMES.findIndex((m) => m.toLowerCase() === match[1].toLowerCase());
      const curYear = parseInt(match[2], 10);
      const curVal = curYear * 12 + curMonth;
      const targetVal = year * 12 + (MONTH_NAMES.indexOf(monthName));
      goPrev = curVal > targetVal;
    }

    const navBtn = page.getByRole('button', {
      name: goPrev ? /Previous month/i : /Next month/i,
    });
    await navBtn.click();
    await page.waitForTimeout(250);
  }

  throw new Error(`Could not navigate calendar to ${target}`);
}

async function clickCalendarDay(page, day, monthName, year) {
  const calendar = page.locator('.MuiPickersLayout-root, .MuiDateCalendar-root').last();
  await calendar.waitFor({ state: 'visible', timeout: 5000 });

  const dayStr = String(day);
  const monthShort = monthName.slice(0, 3); // MUI aria-label is often "Jul 16, 2026"
  const ariaRe = new RegExp(
    `(${monthShort}|${monthName}).*\\b${day}\\b.*${year}|\\b${day}\\b.*(${monthShort}|${monthName}).*${year}`,
    'i'
  );

  // Prefer enabled day with exact day text (not outside-month)
  let dayBtn = calendar
    .locator('button.MuiPickersDay-root:not(.MuiPickersDay-dayOutsideMonth):not([disabled])')
    .filter({ hasText: new RegExp(`^\\s*${dayStr}\\s*$`) })
    .first();

  if (!(await dayBtn.isVisible({ timeout: 1500 }).catch(() => false))) {
    dayBtn = calendar.getByRole('gridcell', { name: ariaRe }).first();
  }

  const clickDayInDom = async () => {
    return calendar.evaluate(
      (el, { dayText, yearText, monthShortText }) => {
        const buttons = [
          ...el.querySelectorAll(
            'button.MuiPickersDay-root:not(.MuiPickersDay-dayOutsideMonth)'
          ),
        ];
        const match = buttons.find((b) => {
          if (b.disabled || b.getAttribute('disabled') != null) return false;
          const text = (b.textContent || '').trim();
          if (text !== dayText) return false;
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          if (
            aria &&
            (!aria.includes(String(yearText)) || !aria.includes(monthShortText.toLowerCase()))
          ) {
            return false;
          }
          return true;
        });
        if (!match) return false;
        match.scrollIntoView({ block: 'center' });
        match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        match.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        match.click();
        return true;
      },
      { dayText: dayStr, yearText: String(year), monthShortText: monthShort }
    );
  };

  if (await dayBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dayBtn.scrollIntoViewIfNeeded();
    // force: true — MUI can hover the day without registering a normal Playwright click
    await dayBtn.click({ force: true });
    console.log(`Clicked calendar day ${day} ${monthName} ${year}`);
  } else {
    const clicked = await clickDayInDom();
    if (!clicked) {
      throw new Error(
        `Could not click calendar day ${day} ${monthName} ${year} (day may be disabled — max range is often From+4)`
      );
    }
    console.log(`Clicked calendar day ${day} via DOM click`);
  }

  await page.waitForTimeout(400);
  // If calendar still open, selection didn't stick — click again via DOM
  if (await calendar.isVisible().catch(() => false)) {
    await clickDayInDom();
    await page.waitForTimeout(300);
  }
}

async function readDateInputValue(page, which) {
  const id = which === 'end' ? '#purchaseDate-end' : '#purchaseDate-start';
  const el = page.locator(id);
  const value = (await el.inputValue().catch(() => '')) || '';
  const text = (await el.innerText().catch(() => '')) || '';
  return (value || text || '').trim();
}

async function selectDateFromPicker(page, groupAriaLabel, dateStr) {
  const { day, monthName, year } = parseDateParts(dateStr);
  console.log(`Selecting ${groupAriaLabel}: ${day} ${monthName} ${year} from calendar (no typing)`);

  await openDatePicker(page, groupAriaLabel);
  await navigateCalendarToMonth(page, monthName, year);
  await clickCalendarDay(page, day, monthName, year);
  await page.waitForTimeout(500);

  // Close popover so the next field can open cleanly
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

async function fillDateRange(page, startDate, endDate) {
  // 5-day inclusive window = start + 4 (e.g. 12/07 → 16/07). Calendar click only — never type.
  const expectedEnd = endDateWithDiff(startDate, 4);
  let toDate = endDate || expectedEnd;
  if (toDate === startDate) toDate = expectedEnd;

  console.log(`Purchase Date (calendar only): ${startDate} → ${toDate} (5-day inclusive)`);
  await selectDateFromPicker(page, 'Start date', startDate);
  await page.waitForTimeout(600);

  const startVal = await readDateInputValue(page, 'start');
  console.log(`Start date field after pick: "${startVal || '(set)'}"`);

  await selectDateFromPicker(page, 'End date', toDate);
  await page.waitForTimeout(400);

  const endVal = await readDateInputValue(page, 'end');
  console.log(`End date field after pick: "${endVal || '(set)'}"`);

  // If End accidentally matches Start, re-open End calendar and pick again
  if (endVal && startVal && endVal === startVal) {
    console.warn('End date matched Start — re-selecting End from calendar...');
    await selectDateFromPicker(page, 'End date', toDate);
  }
}

async function fillAmountRange(page, amountFrom, amountTo) {
  console.log(`Amount: ${amountFrom} → ${amountTo}`);
  await typeInto(page, page.locator('#purchaseTotalAmount-min'), amountFrom);
  await typeInto(page, page.locator('#purchaseTotalAmount-max'), amountTo);
}

async function fillIdentifyBy(page, details) {
  const identifyBy = (details.identifyBy || 'card').toLowerCase();
  console.log(`Identify by: ${identifyBy}`);

  if (identifyBy === 'flybuys') {
    await page.locator('input[type="radio"][value="flybuys"]').check({ force: true });
    await typeInto(page, page.locator('#flybuys-id-field'), details.flybuysId);
    console.log(`Flybuys: ${details.flybuysId}`);
  } else if (identifyBy === 'onepass') {
    await page.locator('input[type="radio"][value="onepass"]').check({ force: true });
    await typeInto(page, page.locator('#onepass-id-field'), details.onepassId);
    console.log(`OnePass: ${details.onepassId}`);
  } else {
    await page.locator('input[type="radio"][value="card"]').check({ force: true });
    await typeInto(page, page.locator('#card-last-three-field'), details.cardLastThree);
    console.log(`Card last 3: ${details.cardLastThree}`);
  }
}

async function fillStore(page, storeNameOrNumber) {
  console.log(`Store: ${storeNameOrNumber}`);
  const storeInput = page.locator('#store-select');
  await storeInput.waitFor({ state: 'visible', timeout: 15000 });

  // Open dropdown and type store number
  await storeInput.click();
  await storeInput.fill('');
  await page.waitForTimeout(300);
  await storeInput.type(String(storeNameOrNumber), { delay: 100 });
  console.log(`Typed store "${storeNameOrNumber}" — waiting for dropdown (needs auth token)...`);

  // Wait for loading indicator if it appears
  const loading = page.getByText('Loading stores...');
  if (await loading.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('Store list loading...');
    await loading.waitFor({ state: 'hidden', timeout: 30000 });
  }

  // Wait until a real option that contains the store number is displayed
  const storeOption = page
    .getByRole('option')
    .filter({ hasText: new RegExp(String(storeNameOrNumber)) })
    .first();

  await storeOption.waitFor({ state: 'visible', timeout: 30000 });
  const optionText = (await storeOption.innerText()).trim();
  console.log(`Dropdown ready — selecting: "${optionText}"`);
  await storeOption.click();

  // Wait after selection so the form registers the store
  await page.waitForTimeout(2000);

  // Confirm selection stuck (value or selected label visible)
  const selectedValue = await storeInput.inputValue();
  const hasSelectedChip = await page
    .locator('#store-select')
    .evaluate((el) => el.value && el.value.length > 0)
    .catch(() => false);

  if (!selectedValue && !hasSelectedChip) {
    // One more check: autocomplete often keeps label text in the input
    const current = await storeInput.inputValue();
    if (!current || !current.includes(String(storeNameOrNumber))) {
      throw new Error(`Store "${storeNameOrNumber}" was not selected from dropdown`);
    }
  }

  console.log(`Store selected: ${selectedValue || optionText}`);
  console.log('Waiting before Search...');
  await page.waitForTimeout(2000);
}

async function fillDigitalReceiptNumber(page, digitalReceiptNumber) {
  console.log(`Digital Receipt Number: ${digitalReceiptNumber}`);
  const input = page.locator('#digital-receipt-number-field, input[placeholder*="1382" i]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await typeInto(page, input, digitalReceiptNumber);
}

/** Locators for real result cards (not the search form amounts). */
function receiptResultCards(page) {
  return page
    .locator('[class*="MuiPaper"], [class*="MuiCard"], [role="button"], a, li')
    .filter({ hasText: /Receipt Number/i })
    .filter({ hasText: /\b\d{18,}\b|\$\s*\d+/ });
}

async function waitForReceiptResults(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  // Leave the form: button shows Searching..., then navigates to /search-results
  await Promise.race([
    page.waitForURL((url) => String(url).includes('search-results'), { timeout: timeoutMs }),
    page.getByRole('button', { name: /Searching/i }).waitFor({ state: 'visible', timeout: 8000 }),
  ]).catch(() => {});

  // Wait until Searching finishes (button gone or back to Search / results page)
  while (Date.now() < deadline) {
    const searching = await page
      .getByRole('button', { name: /Searching/i })
      .isVisible()
      .catch(() => false);
    if (!searching) break;
    await page.waitForTimeout(400);
  }

  // Prefer URL change onto results list
  if (!page.url().includes('search-results')) {
    await page
      .waitForURL((url) => String(url).includes('search-results'), {
        timeout: Math.max(5000, deadline - Date.now()),
      })
      .catch(() => {});
  }

  // Wait out skeleton placeholders if present
  const skeletons = page.locator(
    '[class*="MuiSkeleton"], [class*="skeleton" i], [aria-busy="true"]'
  );
  if (await skeletons.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    console.log('Results page showing skeletons — waiting for cards...');
    await skeletons
      .first()
      .waitFor({ state: 'hidden', timeout: Math.max(5000, deadline - Date.now()) })
      .catch(() => {});
  }

  const remaining = Math.max(5000, deadline - Date.now());
  const heading = page.getByText(/\d+\s+Receipts?/i).first();
  const empty = page.getByText(/No receipts|0\s+Receipts|No results/i).first();
  const cards = receiptResultCards(page);

  await Promise.race([
    heading.waitFor({ state: 'visible', timeout: remaining }),
    empty.waitFor({ state: 'visible', timeout: remaining }),
    cards.first().waitFor({ state: 'visible', timeout: remaining }),
    // Store line on a card e.g. "Kmart Blacktown - 14/07/26"
    page
      .getByText(/Kmart\s+\w[\w\s]*\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i)
      .first()
      .waitFor({ state: 'visible', timeout: remaining }),
  ]).catch(() => {
    throw new Error(
      'Timed out waiting for receipt results list (heading, cards, or empty state).'
    );
  });

  // Give cards a moment to paint after heading/skeletons
  await page.waitForTimeout(800);
}

async function submitReceiptSearch(page) {
  console.log('Clicking Search...');
  const searchBtn = page.getByRole('button', { name: /^Search$/i });
  await searchBtn.waitFor({ state: 'visible', timeout: 10000 });
  await searchBtn.click();

  console.log('Waiting for receipt results (not form amounts)...');
  await waitForReceiptResults(page, 60000);
  await screenshot(page, 'receipt_lookup_result');
  console.log('Receipt search submitted.');
}

/** Read "2 Receipts" (or card count) from the results list. */
async function countReceiptsOnResultsPage(page) {
  const heading = page.getByText(/\d+\s+Receipts?/i).first();
  if (await heading.isVisible({ timeout: 5000 }).catch(() => false)) {
    const text = ((await heading.innerText()) || '').trim();
    const m = text.match(/(\d+)\s+Receipts?/i);
    if (m) {
      const n = parseInt(m[1], 10);
      console.log(`Receipt Lookup UI shows ${n} receipt card(s) ("${text}").`);
      return n;
    }
  }

  // Fallback: count receipt cards by store/amount pattern
  const cards = page
    .locator('[class*="MuiPaper"], [class*="MuiCard"]')
    .filter({ hasText: /Receipt Number|\$\d+/i });
  const n = await cards.count();
  console.log(`Receipt Lookup UI card count (fallback): ${n}`);
  return n;
}

/**
 * Capture each result card: store, date, receipt number, amount.
 * Example card text:
 *   Kmart Blacktown - 14/07/26
 *   Receipt Number
 *   1002202607141130818662
 *   $42.00
 */
async function captureUiReceiptCards(page) {
  const cards = page
    .locator('[class*="MuiPaper"], [class*="MuiCard"], [class*="receipt" i]')
    .filter({ hasText: /Receipt Number/i })
    .filter({ hasText: /\$\d+/ });

  let n = await cards.count();
  const receipts = [];

  // Fallback: parse from results region text if card locators miss
  const parseFromText = (block) => {
    const receiptNumber = (block.match(/\b(\d{18,})\b/) || [])[1] || null;
    const amountRaw = (block.match(/\$\s*([\d,]+\.?\d*)/) || [])[1] || null;
    const amount = amountRaw ? amountRaw.replace(/,/g, '') : null;
    const storeDate = block.match(/([A-Za-z][A-Za-z0-9 .&'-]+?)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    return {
      store: storeDate ? storeDate[1].trim() : null,
      date: storeDate ? storeDate[2] : null,
      receiptNumber,
      amount,
      raw: block.replace(/\s+/g, ' ').trim().slice(0, 200),
    };
  };

  if (n > 0) {
    for (let i = 0; i < n; i++) {
      const text = ((await cards.nth(i).innerText().catch(() => '')) || '').trim();
      if (!text) continue;
      const parsed = parseFromText(text);
      if (parsed.receiptNumber) receipts.push(parsed);
    }
  }

  if (receipts.length === 0) {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '');
    const chunks = body.split(/Receipt Number/i).slice(1);
    for (const chunk of chunks) {
      const parsed = parseFromText('Receipt Number' + chunk.slice(0, 300));
      if (parsed.receiptNumber) receipts.push(parsed);
    }
  }

  // De-dupe by receipt number
  const seen = new Set();
  const unique = [];
  for (const r of receipts) {
    if (!r.receiptNumber || seen.has(r.receiptNumber)) continue;
    seen.add(r.receiptNumber);
    unique.push(r);
  }

  console.log(`Captured ${unique.length} UI receipt card(s) for Sumo list compare:`);
  for (const r of unique) {
    console.log(
      `  • ${r.receiptNumber} | ${r.store || '?'} | ${r.date || '?'} | $${r.amount || '?'}`
    );
  }
  return unique;
}

function ddMmYyyyToIso(dateStr) {
  const { day, month, year } = parseDateParts(dateStr);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** After Search: open first receipt (detail) → wait → New Search → close. Returns UI count + card list. */
async function openReceiptDocumentThenClose(page) {
  console.log('\nOpening first receipt from the results list...');

  // Results may show "2 Receipts" heading and/or cards — don't require heading alone
  const heading = page.getByText(/\d+\s+Receipts?/i).first();
  const cards = receiptResultCards(page);
  await Promise.race([
    heading.waitFor({ state: 'visible', timeout: 15000 }),
    cards.first().waitFor({ state: 'visible', timeout: 15000 }),
    page
      .getByText(/Kmart\s+\w[\w\s]*\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i)
      .first()
      .waitFor({ state: 'visible', timeout: 15000 }),
  ]).catch(() => {
    throw new Error('Receipt results list never showed a heading or cards.');
  });

  const uiReceiptCount = await countReceiptsOnResultsPage(page);
  const uiReceipts = await captureUiReceiptCards(page);

  if (!uiReceiptCount && !uiReceipts.length) {
    throw new Error('No receipt cards found on the results list.');
  }

  // Prefer the first receipt CARD (not the footer New Search / Back buttons)
  const firstCard = cards.first();
  const storeLine = page
    .getByText(/Kmart\s+\w[\w\s]*\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i)
    .first();
  const receiptNumber = page.getByText(/\b\d{18,}\b/).first();

  const beforeUrl = page.url();
  console.log(`Results URL: ${beforeUrl}`);

  let clicked = false;
  if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstCard.click({ force: true });
    clicked = true;
    console.log('Clicked first receipt card.');
  } else if (await storeLine.isVisible({ timeout: 2000 }).catch(() => false)) {
    await storeLine.click({ force: true });
    clicked = true;
    console.log('Clicked first receipt store line.');
  } else if (await receiptNumber.isVisible({ timeout: 2000 }).catch(() => false)) {
    await receiptNumber.click({ force: true });
    clicked = true;
    console.log('Clicked first receipt number.');
  }

  if (!clicked) {
    throw new Error('Could not find the first receipt card on the results list.');
  }

  // Must leave the list page — URL usually leaves /search-results, or "2 Receipts" goes away
  const leftList = await Promise.race([
    page
      .waitForURL((url) => !String(url).includes('search-results'), { timeout: 12000 })
      .then(() => true)
      .catch(() => false),
    page
      .getByText(/\d+\s+Receipts?/i)
      .first()
      .waitFor({ state: 'hidden', timeout: 12000 })
      .then(() => true)
      .catch(() => false),
    // Detail view markers while still possibly on a nested route
    page
      .getByText(/Tax Invoice|Total Items|SALE:/i)
      .first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .then(() => true)
      .catch(() => false),
  ]);

  // Fallback: second click via evaluate on first card-like node
  if (!leftList && beforeUrl === page.url()) {
    console.warn('Still on results list after click — trying DOM click on first card...');
    await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll('[class*="MuiPaper"], [class*="MuiCard"], [role="button"]'),
      ];
      const card = nodes.find(
        (el) =>
          /Receipt Number/i.test(el.textContent || '') &&
          (/\b\d{18,}\b/.test(el.textContent || '') || /\$\s*\d+/.test(el.textContent || ''))
      );
      if (card) card.click();
    });
    await page
      .waitForURL((url) => !String(url).includes('search-results'), { timeout: 10000 })
      .catch(() => {});
    await page
      .getByText(/\d+\s+Receipts?/i)
      .first()
      .waitFor({ state: 'hidden', timeout: 8000 })
      .catch(() => {});
    await page
      .getByText(/Tax Invoice|Total Items|SALE:/i)
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => {});
  }

  const stillOnList =
    page.url().includes('search-results') &&
    (await page.getByText(/\d+\s+Receipts?/i).first().isVisible().catch(() => false)) &&
    !(await page.getByText(/Tax Invoice|Total Items|SALE:/i).first().isVisible().catch(() => false));

  if (stillOnList) {
    throw new Error(
      'Receipt detail did not open — still on the "2 Receipts" list. Check that the first card is clickable.'
    );
  }

  console.log(`Receipt detail URL: ${page.url()}`);
  // Wait for receipt body content (not just empty shell + New Search)
  await page
    .getByText(/\$\d+|Receipt Number|Kmart|Item|Total|Tax|Qty|SALE:/i)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => console.warn('Receipt body content still empty after wait — continuing.'));
  await page.waitForTimeout(1000);
  await screenshot(page, 'receipt_document_open');

  const viewSeconds = Math.max(CONFIG.receiptViewSeconds || 10, 8);
  console.log(`Keeping receipt detail open for ${viewSeconds}s before New Search...`);
  await page.waitForTimeout(viewSeconds * 1000);

  const newSearchBtn = page.getByRole('button', { name: /New Search/i }).first();
  await newSearchBtn.waitFor({ state: 'visible', timeout: 10000 });
  await newSearchBtn.click();
  console.log('Clicked New Search.');
  await page.waitForTimeout(1500);
  await screenshot(page, 'receipt_new_search');

  console.log('Closing Receipt Lookup window...');
  await page.close().catch(async () => {
    await page.goto('about:blank').catch(() => {});
  });

  return { uiReceiptCount, uiReceipts };
}

async function performReceiptLookup(page, context, tokenHolder) {
  await openReceiptLookup(page);
  await selectTab(page, CONFIG.searchMode);

  if (CONFIG.searchMode === 'byDigitalReceiptNumber') {
    if (!CONFIG.digitalReceiptNumber) {
      throw new Error('CONFIG.digitalReceiptNumber is required for byDigitalReceiptNumber mode');
    }
    await fillDigitalReceiptNumber(page, CONFIG.digitalReceiptNumber);
  } else {
    const d = CONFIG.byDetails;
    await fillDateRange(page, d.startDate, d.endDate);
    await fillAmountRange(page, d.amountFrom, d.amountTo);
    await fillIdentifyBy(page, d);
    if (context && tokenHolder && tokenHolder.value) {
      const before = tokenHolder.value;
      await refreshTokenIfNeeded(context, tokenHolder);
      if (tokenHolder.value !== before) {
        console.log('Token changed — reloading Receipt Lookup page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        await selectTab(page, CONFIG.searchMode);
        await fillDateRange(page, d.startDate, d.endDate);
        await fillAmountRange(page, d.amountFrom, d.amountTo);
        await fillIdentifyBy(page, d);
      }
    }
    await fillStore(page, d.storeNameOrNumber);
  }

  await screenshot(page, 'receipt_lookup_filled');
  await page.waitForTimeout(1500);
  await submitReceiptSearch(page);
  const result = await openReceiptDocumentThenClose(page);
  return {
    uiReceiptCount: result?.uiReceiptCount ?? null,
    uiReceipts: result?.uiReceipts || [],
  };
}

// ─── Step 2: Sumo Logic ──────────────────────────────────────────────────────

async function isSumoLoginPage(page) {
  // Explicit login markers — never treat loading spinner as "logged in"
  if (await page.getByText(/locked out of your account/i).isVisible({ timeout: 600 }).catch(() => false)) {
    return true;
  }
  if (await page.getByText(/Welcome back/i).isVisible({ timeout: 600 }).catch(() => false)) {
    return true;
  }
  const signIn = page.getByRole('button', { name: /^Sign in$/i });
  const kmartSso = page.getByRole('button', { name: /^Kmart$/i });
  return (
    ((await signIn.isVisible({ timeout: 600 }).catch(() => false)) ||
      (await kmartSso.isVisible({ timeout: 600 }).catch(() => false))) &&
    /sumologic\.com/i.test(page.url())
  );
}

async function isSumoAuthenticatedSearch(page) {
  const url = page.url();
  if (!/sumologic\.com/i.test(url)) return false;
  if (await isSumoLoginPage(page)) return false;
  if (!/#\/search/i.test(url)) return false;

  // Real search UI markers from your screenshot (query + -24h + editor)
  const queryPresent = await page
    .getByText(/_collector\s*=\s*"dsf-cs-receiptlookup"|dsfcs\/prod\/aws\/ecs\/api/i)
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  const timeChip = await page
    .locator('button, [role="button"]')
    .filter({ hasText: /^-?\d+[hm]$/i })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  const editor = await page
    .locator('.cm-content, .CodeMirror, .monaco-editor, [contenteditable="true"]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  return queryPresent || timeChip || editor;
}

async function assertNoAzureAssignmentBlock(page) {
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
  if (!/AADSTS50105|specifically granted \('assigned'\) access/i.test(body)) return;
  throw new Error(
    'Azure blocked Kmart SSO (AADSTS50105): Janaki.Doddannavara@anko.com is not assigned to SumoLogic.\n' +
      'Ask IAM to assign that user directly, or add them as a direct member of the Sumo access group.\n' +
      'Until IAM does that, quit Chrome and re-run with browserMode: "os-chrome" so the script reuses your existing Sumo session.'
  );
}

async function loginToSumo(page) {
  console.log('\n[4/4] Opening Sumo Logic...');
  await page.goto(CONFIG.sumoSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await assertNoAzureAssignmentBlock(page);

  if (await page.getByText(/locked out of your account/i).isVisible({ timeout: 2000 }).catch(() => false)) {
    throw new Error(
      'Sumo account is LOCKED OUT. Unlock via admin, then re-run (or use Kmart SSO if available).'
    );
  }

  if (await isSumoAuthenticatedSearch(page)) {
    console.log('Sumo Logic: already authenticated on search UI.');
    await screenshot(page, 'sumo_after_login');
    return;
  }

  if (!CONFIG.sumoPassword) {
    throw new Error('Sumo password missing — set SUMO_PASSWORD in .env');
  }

  // 1) Email + password (as provided) — only one attempt to avoid lockout
  console.log(`Sumo Logic: signing in as ${CONFIG.sumoEmail}...`);
  const emailField = page
    .locator('input[type="email"], input[name="email"], input#email, input[name="username"]')
    .first();
  const passwordField = page.locator('input[type="password"]').first();
  if (await emailField.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailField.fill('');
    await emailField.fill(CONFIG.sumoEmail);
  }
  if (await passwordField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await passwordField.fill(CONFIG.sumoPassword);
  }
  const signInBtn = page.getByRole('button', { name: /^Sign in$/i }).first();
  if (await signInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await signInBtn.click();
    await page.waitForTimeout(5000);
  }

  // 2FA if prompted
  const mfaField = page
    .locator('input[name="code"], input[placeholder*="code" i], input[aria-label*="code" i]')
    .first();
  if (await mfaField.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('2FA detected — enter verification code in the browser (120 s)...');
  }

  // 2) If password rejected, try Kmart SSO once (may need MFA / may hit AADSTS50105)
  const credError = page.getByText(/verify your credentials|identity provider|locked out/i);
  if ((await credError.isVisible({ timeout: 3000 }).catch(() => false)) || (await isSumoLoginPage(page))) {
    if (await page.getByText(/locked out/i).isVisible({ timeout: 1000 }).catch(() => false)) {
      throw new Error('Sumo account locked out after password attempt — unlock via admin.');
    }
    console.log('Password sign-in not accepted — trying Kmart SSO...');
    const kmart = page.getByRole('button', { name: /^Kmart$/i }).or(page.getByText(/^Kmart$/));
    if (await kmart.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await kmart.first().click();
      console.log('Complete Kmart SSO / MFA in the browser if prompted (up to 3 min)...');
    }
  }

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await assertNoAzureAssignmentBlock(page);
    if (await page.getByText(/locked out of your account/i).isVisible({ timeout: 500 }).catch(() => false)) {
      throw new Error('Sumo account locked out — contact admin to unlock.');
    }
    if (await isSumoAuthenticatedSearch(page)) break;

    const url = page.url();
    if (
      /sumologic\.com\/ui/i.test(url) &&
      !(await isSumoLoginPage(page)) &&
      !/#\/search/i.test(url)
    ) {
      console.log('Logged in — opening saved search URL...');
      await page.goto(CONFIG.sumoSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(4000);
      continue;
    }
    await page.waitForTimeout(2000);
  }

  await screenshot(page, 'sumo_after_login');

  if (await isSumoLoginPage(page)) {
    throw new Error(
      'Still on Sumo login. Check email/password, complete MFA, or ask IAM for Sumo app access.'
    );
  }
  if (!(await isSumoAuthenticatedSearch(page))) {
    throw new Error('Sumo search UI not ready after login.');
  }
  console.log('Sumo Logic login complete — search screen ready.');
}
async function setSumoQueryText(page, query) {
  if (await isSumoLoginPage(page)) {
    console.warn('Still on login — not typing query into login fields.');
    return false;
  }

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const expected = query.replace(/\s+/g, ' ').trim();

  // Click the main search editor (not the left sidebar recent-search box)
  const editorSurface = page.locator('.CodeMirror').first();
  if (!(await editorSurface.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.warn('Sumo CodeMirror editor not found.');
    return false;
  }
  await editorSurface.click({ force: true });
  await page.waitForTimeout(200);

  // Hard clear (removes leftover `| where (level = "err")` from saved search)
  await page.keyboard.press(`${mod}+A`);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);

  // Set value via CodeMirror API + verify
  const setViaDom = await page.evaluate((q) => {
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      cm5.CodeMirror.focus();
      cm5.CodeMirror.setValue(q);
      cm5.CodeMirror.refresh();
      return cm5.CodeMirror.getValue();
    }
    return null;
  }, query);

  if (typeof setViaDom === 'string') {
    const got = setViaDom.replace(/\s+/g, ' ').trim();
    if (got === expected || got.startsWith(expected)) {
      // Extra strip if anything after our query (saved-search remnants)
      if (got !== expected) {
        await page.evaluate((q) => {
          const cm5 = document.querySelector('.CodeMirror');
          if (cm5 && cm5.CodeMirror) cm5.CodeMirror.setValue(q);
        }, query);
      }
      console.log('Sumo query cleared and pasted successfully.');
      await page.waitForTimeout(400);
      return true;
    }
    console.warn(`Editor value mismatch after setValue. Got: ${got.slice(0, 120)}`);
  }

  // Fallback: clipboard paste after clear
  try {
    await page.evaluate(async (q) => {
      await navigator.clipboard.writeText(q);
    }, query);
    await editorSurface.click({ force: true });
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.press('Backspace');
    await page.keyboard.press(`${mod}+V`);
    console.log('Sumo query pasted via clipboard.');
    await page.waitForTimeout(400);
    return true;
  } catch (err) {
    console.warn(`Clipboard paste failed: ${err.message}`);
  }

  return false;
}

/** Click time control on the right of the query and choose Last 60 Minutes. */
async function setSumoTimeLast60Minutes(page) {
  console.log('Setting Sumo time range to Last 60 Minutes...');

  try {
    // Already on -60m?
    const already60 = page
      .locator('button, [role="button"], [class*="time" i]')
      .filter({ hasText: /^-60m$/i })
      .first();
    if (await already60.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('Time already -60m.');
      return;
    }

    // Sumo time control: -24h chip OR absolute range like "09/02/2026 10:36:28 AM to ..."
    const candidates = [
      page.getByText(/\d{1,2}\/\d{1,2}\/\d{4}.*to/i).first(),
      page.locator('button, [role="button"]').filter({ hasText: /\d{1,2}\/\d{1,2}\/\d{4}/i }).first(),
      page.locator('button, [role="button"]').filter({ hasText: /^-?\d+[hm]$/i }).first(),
      page.locator('[data-testid*="time" i], [aria-label*="time" i], [class*="TimeRange" i]').first(),
      page.getByRole('button', { name: /time|relative|absolute|Last/i }).first(),
    ];

    let opened = false;
    for (const loc of candidates) {
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ force: true });
        opened = true;
        console.log('Opened Sumo time picker.');
        break;
      }
    }

    if (!opened) {
      console.warn('Time picker control not found — continuing with current range.');
      await screenshot(page, 'sumo_time_picker_missing');
      return;
    }

    await page.waitForTimeout(1000);
    await screenshot(page, 'sumo_time_picker_open');

    const presets = [
      page.getByRole('option', { name: /Last 60 Minutes/i }),
      page.getByRole('menuitem', { name: /Last 60 Minutes/i }),
      page.getByText(/^Last 60 Minutes$/i),
      page.getByText(/^Last 60 mins$/i),
      page.getByText(/^Last 1 Hour$/i),
      page.getByText(/^-60m$/i),
      page.locator('[data-value="-60m"]'),
    ];

    for (const preset of presets) {
      if (await preset.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await preset.first().click();
        console.log('Selected Last 60 Minutes preset.');
        await page.waitForTimeout(500);
        return;
      }
    }

    const relative = page.getByText(/^Relative$/i).first();
    if (await relative.isVisible({ timeout: 2000 }).catch(() => false)) {
      await relative.click();
      await page.waitForTimeout(400);
    }

    const relativeInput = page
      .locator('input[placeholder*="relative" i], input[aria-label*="relative" i], input[type="text"]')
      .last();
    if (await relativeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await relativeInput.fill('-60m');
      await page.keyboard.press('Enter');
      console.log('Set relative time to -60m via input.');
      await page.waitForTimeout(500);
      // Close any leftover time-range popover so it does not block Expand/Search
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      return;
    }

    console.warn('Could not select Last 60 Minutes — leaving current time range.');
    await page.keyboard.press('Escape').catch(() => {});
  } catch (err) {
    console.warn(`Time range step skipped (${err.message}) — continuing with current range.`);
    await page.keyboard.press('Escape').catch(() => {});
    await screenshot(page, 'sumo_time_picker_error').catch(() => {});
  }
}

async function getSumoEditorQuery(page) {
  return page.evaluate(() => {
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) return cm5.CodeMirror.getValue() || '';
    const content = document.querySelector('.cm-content[contenteditable="true"]');
    if (content) return content.innerText || content.textContent || '';
    return '';
  });
}

function normalizeSumoQuery(q) {
  return String(q || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when editor already has the intended query (exact enough — do not re-paste). */
function sumoQueryAlreadyEntered(current, wanted) {
  const c = normalizeSumoQuery(current);
  const w = normalizeSumoQuery(wanted);
  if (!c || !w) return false;
  if (c === w) return true;

  const cFlat = c.replace(/\s*\|\s*/g, ' | ').replace(/\s+/g, ' ');
  const wFlat = w.replace(/\s*\|\s*/g, ' | ').replace(/\s+/g, ' ');
  if (cFlat === wFlat) return true;

  // Reject leftover error-level filters
  if (/\|\s*where[\s{]*level/i.test(c)) return false;

  const hasCollector = /_collector\s*=\s*"dsf-cs-receiptlookup"/i.test(c);
  const hasCategory = /_sourceCategory\s*=\s*"dsfcs\/prod\/aws\/ecs\/api"/i.test(c);
  const wantsNoHttpLogger = /Context\s*!=\s*"HttpRequestLogger"/i.test(w);
  const hasNoHttpLogger = /Context\s*!=\s*"HttpRequestLogger"/i.test(c);

  return (
    hasCollector &&
    hasCategory &&
    (!wantsNoHttpLogger || hasNoHttpLogger) &&
    cFlat.includes(wFlat.split('|')[0].trim())
  );
}

async function clickSumoSearchButton(page) {
  // Blue magnifying-glass button to the right of time range
  const mag = page
    .locator(
      'button[aria-label*="Search" i], button[title*="Search" i], [data-test*="run-search" i], [data-test*="start-search" i]'
    )
    .or(page.getByRole('button', { name: /^Search$|^Start$|^Run$/i }))
    .first();

  if (await mag.isVisible({ timeout: 5000 }).catch(() => false)) {
    await mag.click();
    console.log('Clicked Sumo Search (magnifying glass).');
    return;
  }

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  console.log('Triggered Sumo search via keyboard shortcut.');
}

/** Click the caret beside Expand/Collapse All Rows, then choose "Expand All Rows And JSON". */
async function expandAllSumoRowsAndJson(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  if (
    await page
      .getByText(/Collapse All Rows And JSON/i)
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false)
  ) {
    console.log('Sumo rows already expanded (Collapse All Rows And JSON visible).');
    return true;
  }

  // Label may already say "Collapse All Rows" (plain expand) — still open the caret menu for JSON.
  const rowToggle = page
    .getByText(/^(Expand|Collapse) All Rows( And JSON)?$/i)
    .first();

  if (!(await rowToggle.isVisible({ timeout: 8000 }).catch(() => false))) {
    console.warn('Expand/Collapse All Rows control not found.');
    await screenshot(page, 'sumo_expand_menu_missing');
    return false;
  }

  const labelText = ((await rowToggle.innerText().catch(() => '')) || '').trim();
  console.log(`Sumo row toggle label: "${labelText}"`);

  const openCaretMenu = async () => {
    // Prefer a dedicated caret/chevron button next to the label
    const caretCandidates = [
      rowToggle.locator('xpath=following-sibling::button[1]'),
      rowToggle.locator('xpath=following-sibling::*[1]//button'),
      rowToggle.locator('xpath=ancestor::*[self::button or @role="button"][1]/following-sibling::button[1]'),
      rowToggle.locator(
        'xpath=ancestor::*[contains(@class,"split") or contains(@class,"dropdown") or contains(@class,"button-group")][1]//button[last()]'
      ),
      page
        .locator('button, [role="button"]')
        .filter({ has: page.locator('svg, [class*="caret" i], [class*="chevron" i], [class*="arrow" i]') })
        .filter({ hasText: /^(Expand|Collapse) All Rows/i }),
    ];

    for (const caret of caretCandidates) {
      const el = caret.first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        await el.click({ force: true });
        console.log('Clicked Expand/Collapse caret button.');
        return true;
      }
    }

    // Split-button: click near the right edge of the parent control
    const parent = page
      .locator('button, [role="button"], [class*="split" i], [class*="dropdown" i], [class*="button-group" i]')
      .filter({ hasText: /^(Expand|Collapse) All Rows/i })
      .first();
    if (await parent.isVisible({ timeout: 1500 }).catch(() => false)) {
      const box = await parent.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
        console.log('Clicked Expand/Collapse down-arrow (right side of control).');
        return true;
      }
    }

    const box = await rowToggle.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width + 14, box.y + box.height / 2);
      console.log('Clicked Expand/Collapse arrow by coordinates next to label.');
      return true;
    }
    return false;
  };

  await openCaretMenu();
  await page.waitForTimeout(800);

  const jsonOption = page
    .getByRole('menuitem', { name: /Expand All Rows And JSON/i })
    .or(page.getByRole('option', { name: /Expand All Rows And JSON/i }))
    .or(page.locator('[role="menu"] , [role="listbox"], .MuiMenu-list, .ant-dropdown-menu').getByText(/Expand All Rows And JSON/i))
    .or(page.getByText(/^Expand All Rows And JSON$/i))
    .first();

  if (await jsonOption.isVisible({ timeout: 5000 }).catch(() => false)) {
    await jsonOption.click({ force: true });
    console.log('Selected "Expand All Rows And JSON".');
    await page.waitForTimeout(2500);
    await screenshot(page, 'sumo_expanded_json');
    return true;
  }

  // Menu may not have opened — retry caret once more
  console.warn('JSON menu item not visible after first caret click — retrying.');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await openCaretMenu();
  await page.waitForTimeout(800);

  if (await jsonOption.isVisible({ timeout: 4000 }).catch(() => false)) {
    await jsonOption.click({ force: true });
    console.log('Selected "Expand All Rows And JSON" (retry).');
    await page.waitForTimeout(2500);
    await screenshot(page, 'sumo_expanded_json');
    return true;
  }

  const direct = page.getByRole('button', { name: /Expand All Rows And JSON/i }).first();
  if (await direct.isVisible({ timeout: 1500 }).catch(() => false)) {
    await direct.click({ force: true });
    console.log('Clicked Expand All Rows And JSON (direct).');
    await page.waitForTimeout(2500);
    await screenshot(page, 'sumo_expanded_json');
    return true;
  }

  console.warn('Could not open Expand All Rows And JSON menu.');
  await screenshot(page, 'sumo_expand_menu_missing');
  return false;
}

/**
 * Parse Sumo page text for ReceiptService "Found N receipt(s)" and search criteria.
 * Also notes KLUE pilot store-fetch messages.
 */
function parseSumoReceiptServiceDetails(bodyText, details) {
  const text = bodyText || '';
  const findings = {
    kluePilotStores: null,
    foundReceipts: null,
    contextReceiptService: /context\s*:\s*"?ReceiptService"?/i.test(text) || /"context"\s*:\s*"ReceiptService"/i.test(text),
    cardLastThreeOk: false,
    cardLastThreeMasked: false,
    flybuysOk: false,
    onepassOk: false,
    storeIdOk: false,
    dateRangeOk: false,
    amountRangeOk: false,
    rawFoundLine: null,
  };

  const klue = text.match(/Successfully fetched\s+(\d+)\s+stores from KLUE pilot/i);
  if (klue) findings.kluePilotStores = parseInt(klue[1], 10);

  const found = text.match(/Found\s+(\d+)\s+receipt\(s\)/i);
  if (found) {
    findings.foundReceipts = parseInt(found[1], 10);
    findings.rawFoundLine = found[0];
  }

  const identifyBy = (details.identifyBy || 'card').toLowerCase();
  if (identifyBy === 'card' && details.cardLastThree) {
    const last3 = String(details.cardLastThree);
    // Sumo "Expand All Rows And JSON" often renders each JSON token on its own line:
    //   cardLastThree
    //   :
    //   "****",
    const keyPresent = /cardLastThree/i.test(text);
    const valuePresent =
      new RegExp(`cardLastThree[\\s:"']{0,40}${last3}\\b`, 'i').test(text) ||
      new RegExp(`"cardLastThree"[\\s:]{0,20}"?(?:\\*{0,4})?${last3}"?`, 'i').test(text);
    const maskedPresent =
      /cardLastThree[\s:"']{0,40}\*{3,}/i.test(text) ||
      /"cardLastThree"[\s:]{0,20}"?\*{3,}"?/i.test(text);
    findings.cardLastThreeOk = valuePresent || (keyPresent && maskedPresent);
    findings.cardLastThreeMasked = maskedPresent && !valuePresent;
  } else if (identifyBy === 'flybuys' && details.flybuysId) {
    findings.flybuysOk =
      new RegExp(`flybuys[^\\d]*${details.flybuysId}`, 'i').test(text) ||
      text.includes(String(details.flybuysId));
  } else if (identifyBy === 'onepass' && details.onepassId) {
    findings.onepassOk =
      new RegExp(`onepass[^\\d]*${details.onepassId}`, 'i').test(text) ||
      text.includes(String(details.onepassId));
  }

  if (details.storeNameOrNumber) {
    // Line-broken JSON: storeId \n : \n "1002"
    findings.storeIdOk =
      new RegExp(`storeId[\\s:"']{0,40}${details.storeNameOrNumber}\\b`, 'i').test(text) ||
      new RegExp(`"storeId"\\s*:\\s*"${details.storeNameOrNumber}"`, 'i').test(text);
  }

  if (details.startDate && details.endDate) {
    const fromIso = ddMmYyyyToIso(details.startDate);
    const toIso = ddMmYyyyToIso(details.endDate);
    findings.dateRangeOk =
      (text.includes(fromIso) && text.includes(toIso)) ||
      (text.includes(details.startDate) && text.includes(details.endDate));
  }

  if (details.amountFrom != null && details.amountTo != null) {
    const min = String(parseFloat(details.amountFrom));
    const max = String(parseFloat(details.amountTo));
    // Line-broken JSON from Sumo; nested totalPriceRange may show min/max on separate lines
    const minOk =
      new RegExp(`(?:^|\\n)\\s*"?min"?\\s*(?::\\s*)?\\n?\\s*"?${min}"?\\b`, 'im').test(text) ||
      new RegExp(`min[\\s:"']{0,20}${min}\\b`, 'i').test(text);
    const maxOk =
      new RegExp(`(?:^|\\n)\\s*"?max"?\\s*(?::\\s*)?\\n?\\s*"?${max}"?\\b`, 'im').test(text) ||
      new RegExp(`max[\\s:"']{0,20}${max}\\b`, 'i').test(text);
    findings.amountRangeOk =
      (minOk && maxOk) ||
      (/totalPriceRange/i.test(text) && maxOk && (minOk || text.includes(`"${min}"`) || new RegExp(`\\n${min},?\\n`).test(text)));
  }

  return findings;
}

async function runSumoQuery(page, query, uiReceiptCount, uiReceipts = []) {
  console.log('\nRunning Sumo query:\n' + query);
  if (uiReceiptCount != null) {
    console.log(`Will compare Sumo "Found N receipt(s)" to UI count: ${uiReceiptCount}`);
  }
  if (uiReceipts.length) {
    console.log(`UI receipt cards captured (${uiReceipts.length}) — count must match Sumo "Found N receipt(s)":`);
    for (const r of uiReceipts) {
      console.log(`  • ${r.receiptNumber} ($${r.amount || '?'}, ${r.date || '?'})`);
    }
  }

  if (await isSumoLoginPage(page)) {
    throw new Error('Cannot run Sumo query — still on login page.');
  }

  await page.goto(CONFIG.sumoSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  if (await isSumoLoginPage(page)) {
    throw new Error('Sumo session expired — still on login.');
  }

  const current = await getSumoEditorQuery(page);
  console.log(`Current Sumo editor query: ${normalizeSumoQuery(current).slice(0, 180)}`);

  if (sumoQueryAlreadyEntered(current, query)) {
    console.log('Search box already has the query — NOT re-pasting; clicking Search.');
  } else {
    console.log('Search box empty/different — clearing editor and pasting your query...');
    const editorOk = await setSumoQueryText(page, query);
    if (!editorOk) {
      console.warn('Could not edit Sumo search bar — will still click Search.');
      await screenshot(page, 'sumo_editor_missing');
    } else {
      console.log('Query pasted. Clicking Search...');
    }
  }

  await setSumoTimeLast60Minutes(page).catch((err) =>
    console.warn(`Time range skipped: ${err.message}`)
  );
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  await clickSumoSearchButton(page);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  console.log('Waiting for Sumo results...');
  await page.waitForTimeout(12000);

  // Wait until processing finishes if status is visible
  await page
    .getByText(/STATUS\s*Done|RESULTS\s+\d+/i)
    .first()
    .waitFor({ state: 'visible', timeout: 60000 })
    .catch(() => {});

  const detailsForHarvest = CONFIG.byDetails || {};

  const criteriaSatisfied = (text) => {
    const p = parseSumoReceiptServiceDetails(text, detailsForHarvest);
    const idOk =
      (detailsForHarvest.identifyBy || 'card').toLowerCase() === 'card'
        ? p.cardLastThreeOk
        : (detailsForHarvest.identifyBy || '').toLowerCase() === 'flybuys'
          ? p.flybuysOk
          : p.onepassOk;
    return p.foundReceipts != null && idOk && p.storeIdOk && p.dateRangeOk && p.amountRangeOk;
  };

  const harvestSumoBodyText = async () => {
    console.log('Scrolling Sumo messages slowly to collect all ReceiptService field details...');
    let accumulated = '';
    const appendVisible = async () => {
      const chunk = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 100000);
      if (!chunk) return;
      // Always merge: virtualized rows replace DOM, so keep a running transcript
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (t.length < 2) continue;
        if (!accumulated.includes(t)) accumulated += '\n' + t;
      }
      if (accumulated.length > 500000) accumulated = accumulated.slice(-500000);
    };

    const messagesPanel = page
      .locator(
        '[class*="messages" i], [class*="MessageTable" i], [class*="message-list" i], [role="grid"], [class*="ag-body" i], [class*="results" i]'
      )
      .first();
    if (await messagesPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await messagesPanel.click({ force: true }).catch(() => {});
    } else {
      const vp = page.viewportSize() || { width: 1400, height: 900 };
      await page.mouse.click(Math.floor(vp.width * 0.62), Math.floor(vp.height * 0.55));
    }
    await page.waitForTimeout(400);
    await appendVisible();

    // Browser find → jump to Searching receipts / cardLastThree / Found / each receipt #
    const findNeedles = ['Searching receipts', 'cardLastThree', 'Found '];
    for (const r of uiReceipts) {
      if (r.receiptNumber) findNeedles.push(r.receiptNumber);
    }
    for (const needle of findNeedles) {
      try {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
        await page.waitForTimeout(250);
        await page.keyboard.type(needle, { delay: 20 });
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(700);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        await appendVisible();
      } catch (_) {
        /* ignore */
      }
    }

    // Slow scroll through messages (data is often near top after Expand JSON; keep a modest pass)
    const maxSteps = 25;
    for (let i = 0; i < maxSteps; i++) {
      if (criteriaSatisfied(accumulated)) {
        console.log(`All CONFIG criteria found in Sumo logs after ${i} slow scroll step(s).`);
        break;
      }

      await page.mouse.wheel(0, 220);
      if (await messagesPanel.isVisible({ timeout: 200 }).catch(() => false)) {
        await messagesPanel
          .evaluate((el) => {
            el.scrollTop += 180;
          })
          .catch(() => {});
      }
      // PageDown every few steps to move through virtualized list
      if (i % 3 === 2) await page.keyboard.press('PageDown').catch(() => {});
      else await page.keyboard.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(650);
      await appendVisible();

      if ((i + 1) % 10 === 0) {
        console.log(`  …scrolled ${i + 1}/${maxSteps} (collected ${accumulated.length} chars)`);
      }
    }

    const foundLoc = page.getByText(/Found\s+\d+\s+receipt\(s\)|Searching receipts|cardLastThree/i).first();
    if (await foundLoc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await foundLoc.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      await appendVisible();
    }

    return accumulated;
  };

  await expandAllSumoRowsAndJson(page);
  await page.waitForTimeout(2000);
  let bodyText = await harvestSumoBodyText();

  // If scheduler noise still hides Found N, refine to ReceiptService only and re-search once.
  if (!/Found\s+\d+\s+receipt\(s\)/i.test(bodyText)) {
    const refined =
      '(_collector="dsf-cs-receiptlookup") and (_sourceCategory="dsfcs/prod/aws/ecs/api") | where Context = "ReceiptService"';
    console.log('Found N not visible yet — refining Sumo query to Context = "ReceiptService"...');
    await setSumoQueryText(page, refined);
    await clickSumoSearchButton(page);
    await page.waitForTimeout(10000);
    await page
      .getByText(/STATUS\s*Done|RESULTS\s+\d+/i)
      .first()
      .waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => {});
    await expandAllSumoRowsAndJson(page);
    await page.waitForTimeout(1500);
    bodyText = await harvestSumoBodyText();
  }

  await screenshot(page, 'sumo_error_logs');
  const details = CONFIG.byDetails || {};
  const parsed = parseSumoReceiptServiceDetails(bodyText, details);

  if (parsed.kluePilotStores != null) {
    console.log(`Sumo: KLUE pilot stores message found (fetched ${parsed.kluePilotStores} stores).`);
  }

  // Primary check (per your Sumo "Found 2 receipt(s)" log): UI card count == Found N
  let compareOk = false;
  const compareNotes = [];

  if (parsed.foundReceipts == null) {
    compareNotes.push('ReceiptService "Found N receipt(s)" message not found in expanded Sumo results.');
  } else {
    console.log(`Sumo ReceiptService: ${parsed.rawFoundLine}`);
    if (uiReceiptCount != null && parsed.foundReceipts === uiReceiptCount) {
      compareOk = true;
      compareNotes.push(
        `COUNT MATCH: UI list shows ${uiReceiptCount} receipt card(s) == Sumo "Found ${parsed.foundReceipts} receipt(s)".`
      );
    } else if (uiReceiptCount != null) {
      compareOk = false;
      compareNotes.push(
        `COUNT MISMATCH: UI list shows ${uiReceiptCount} receipt card(s) != Sumo "Found ${parsed.foundReceipts} receipt(s)".`
      );
    } else if (uiReceipts.length && parsed.foundReceipts === uiReceipts.length) {
      compareOk = true;
      compareNotes.push(
        `COUNT MATCH: captured ${uiReceipts.length} UI card(s) == Sumo "Found ${parsed.foundReceipts} receipt(s)".`
      );
    } else {
      compareNotes.push(`Sumo Found ${parsed.foundReceipts} receipt(s) (UI count not captured).`);
      compareOk = true;
    }
  }

  // Soft: note if individual receipt numbers also appear in logs (Found N log often has criteria only)
  const listMatches = [];
  const listMisses = [];
  for (const r of uiReceipts) {
    if (!r.receiptNumber) continue;
    if (bodyText.includes(r.receiptNumber)) {
      listMatches.push(r);
      compareNotes.push(`UI card ${r.receiptNumber} ($${r.amount || '?'}) also seen in Sumo text.`);
    } else {
      listMisses.push(r);
      compareNotes.push(
        `UI card ${r.receiptNumber} ($${r.amount || '?'}, ${r.date || '?'}) — number not in visible Sumo text (count still uses Found N).`
      );
    }
  }
  if (uiReceipts.length) {
    compareNotes.push(
      `UI cards logged for compare: ${uiReceipts.map((r) => r.receiptNumber).join(', ')}.`
    );
  }

  const identifyBy = (details.identifyBy || 'card').toLowerCase();
  if (identifyBy === 'card') {
    compareNotes.push(
      parsed.cardLastThreeOk
        ? parsed.cardLastThreeMasked
          ? `cardLastThree verified (masked as **** in Sumo; field present with matching search criteria).`
          : `cardLastThree verified (${details.cardLastThree}).`
        : `cardLastThree NOT verified in log (expected ${details.cardLastThree}).`
    );
  } else if (identifyBy === 'flybuys') {
    compareNotes.push(
      parsed.flybuysOk
        ? `Flybuys verified (${details.flybuysId}).`
        : `Flybuys NOT verified in log (expected ${details.flybuysId}).`
    );
  } else if (identifyBy === 'onepass') {
    compareNotes.push(
      parsed.onepassOk
        ? `OnePass verified (${details.onepassId}).`
        : `OnePass NOT verified in log (expected ${details.onepassId}).`
    );
  }

  if (parsed.storeIdOk) compareNotes.push(`storeId verified (${details.storeNameOrNumber}).`);
  else compareNotes.push(`storeId NOT clearly verified (${details.storeNameOrNumber}).`);

  if (parsed.dateRangeOk) compareNotes.push('issuedAtRange dates verified.');
  else compareNotes.push('issuedAtRange dates NOT clearly verified.');

  if (parsed.amountRangeOk) compareNotes.push('totalPriceRange verified.');
  else compareNotes.push('totalPriceRange NOT clearly verified.');

  for (const note of compareNotes) console.log(`  • ${note}`);

  let resultCount = 0;
  const resultsMatch = bodyText.match(/RESULTS\s+(\d+)/i);
  if (resultsMatch) resultCount = parseInt(resultsMatch[1], 10);

  const noResults =
    /no results|0 messages|RESULTS\s+0|No Rows To Show|did not produce any results/i.test(bodyText) &&
    resultCount === 0;

  ensureDir(CONFIG.outputDir);
  const reportPath = path.join(CONFIG.outputDir, `${timestamp()}_sumo_report.txt`);
  fs.writeFileSync(
    reportPath,
    [
      `Timestamp: ${new Date().toISOString()}`,
      `UI receipt cards: ${uiReceiptCount}`,
      `Sumo Found receipt(s): ${parsed.foundReceipts}`,
      `Count compare OK: ${compareOk}`,
      `KLUE pilot stores: ${parsed.kluePilotStores}`,
      `RESULTS count: ${resultCount}`,
      `No results indicator: ${noResults}`,
      `Page URL: ${page.url()}`,
      '',
      'UI receipt list (must count-match Sumo Found N):',
      ...(uiReceipts.length
        ? uiReceipts.map(
            (r, i) =>
              `  ${i + 1}. ${r.receiptNumber} | ${r.store || '?'} | ${r.date || '?'} | $${r.amount || '?'}`
          )
        : ['  (none captured)']),
      '',
      'Query:',
      query,
      '',
      'Verification notes:',
      ...compareNotes.map((n) => `- ${n}`),
      '',
      'Page text excerpt:',
      bodyText.slice(0, 6000),
    ].join('\n')
  );
  console.log(`Report saved: ${reportPath}`);

  if (!compareOk && uiReceiptCount != null) {
    throw new Error(
      `Count mismatch: UI list=${uiReceiptCount} cards vs Sumo Found=${parsed.foundReceipts}. See ${reportPath}`
    );
  }
  if (parsed.foundReceipts == null && !noResults) {
    console.warn('Could not parse Found N receipt(s) — check expanded JSON screenshot / report.');
  }

  return {
    resultCount,
    uiReceiptCount,
    sumoFoundReceipts: parsed.foundReceipts,
    compareOk,
    parsed,
  };
}
// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  ensureDir(CONFIG.outputDir);

  if (!fs.existsSync(CONFIG.extensionPath) && CONFIG.browserMode !== 'inject') {
    console.warn(
      `Extension folder not found at ${CONFIG.extensionPath} — will use inject fallback if needed.`
    );
  }

  // Clear stale profile locks
  const lockDir = path.join(process.cwd(), 'user-data-sumo');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(lockDir, f));
    } catch {
      // ignore
    }
  }

  const { context, page, mode } = await launchBrowserWithExtensions();
  let appliedVia = mode;

  try {
    let tokenHolder = null;

    // 1) Local auth — fetch fresh Network "token" from localhost:7575
    if (CONFIG.runLocalAuth) {
      tokenHolder = await signInAndCaptureToken(page);
    } else {
      console.log('\n[1/4] Local auth skipped (CONFIG.runLocalAuth = false).');
    }

    // 2) Apply token to extension (or inject Config fallback)
    if (CONFIG.runExtensionPaste) {
      if (!tokenHolder?.value) {
        throw new Error('No token to apply — enable CONFIG.runLocalAuth first.');
      }
      appliedVia = await applyToken(context, page, tokenHolder.value, mode);
    } else {
      console.log('\n[2/4] Extension/token apply skipped (CONFIG.runExtensionPaste = false).');
    }

    // 3) Receipt Lookup — enter details + submit
    let uiReceiptCount = null;
    let uiReceipts = [];
    if (CONFIG.runReceiptLookup) {
      const receiptResult = await performReceiptLookup(page, context, tokenHolder);
      uiReceiptCount = receiptResult?.uiReceiptCount ?? null;
      uiReceipts = receiptResult?.uiReceipts || [];
    } else {
      console.log('\n[3/4] Receipt Lookup skipped (CONFIG.runReceiptLookup = false).');
    }

    // 4) Sumo Logic — expand JSON, find ReceiptService Found N, compare to UI card count
    if (CONFIG.runSumoCheck) {
      const sumoPage = await context.newPage();
      await loginToSumo(sumoPage);
      const query =
        (CONFIG.sumoQuery && CONFIG.sumoQuery.trim()) ||
        buildSumoQuery(CONFIG.env, CONFIG.serviceLayer);
      const sumoResult = await runSumoQuery(sumoPage, query, uiReceiptCount, uiReceipts);
      console.log(
        `\nSumo compare: UI=${sumoResult.uiReceiptCount} Found=${sumoResult.sumoFoundReceipts} OK=${sumoResult.compareOk}`
      );
    } else {
      console.log('\n[4/4] Sumo check skipped — provide CONFIG.sumoQuery and set runSumoCheck=true when ready.');
    }

    console.log('\n─── Summary ───');
    console.log(`Token applied via: ${appliedVia}`);
    console.log(`Store        : ${CONFIG.byDetails.storeNameOrNumber}`);
    console.log(`Dates        : ${CONFIG.byDetails.startDate} → ${CONFIG.byDetails.endDate}`);
    console.log(`Amount       : ${CONFIG.byDetails.amountFrom} → ${CONFIG.byDetails.amountTo}`);
    console.log(`Card         : ${CONFIG.byDetails.cardLastThree}`);
    console.log(`UI receipts  : ${uiReceiptCount}`);
    if (uiReceipts.length) {
      for (const r of uiReceipts) {
        console.log(`  - ${r.receiptNumber} | ${r.date || '?'} | $${r.amount || '?'}`);
      }
    }
    console.log(`Output dir   : ${CONFIG.outputDir}`);
    console.log('────────────────\n');

    if (CONFIG.keepOpenSeconds > 0) {
      console.log(`Keeping browser open for ${CONFIG.keepOpenSeconds}s to review...`);
      const anyPage = context.pages()[0] || page;
      await anyPage.waitForTimeout(CONFIG.keepOpenSeconds * 1000).catch(() =>
        new Promise((r) => setTimeout(r, CONFIG.keepOpenSeconds * 1000))
      );
    }
  } catch (err) {
    console.error('\nAutomation failed:', err.message);
    console.error(
      '\nBrowser will stay open so you can check.'
    );
    const errPage = context.pages()[0];
    if (errPage) await screenshot(errPage, 'error_state').catch(() => {});
    const holdSeconds = Math.max(CONFIG.keepOpenSeconds || 0, 60);
    console.log(`Keeping browser open for ${holdSeconds}s...`);
    await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    process.exitCode = 1;
  } finally {
    stopLocalAuthServer();
    if (attachedToExistingChrome) {
      console.log('Left your Chrome open (attached to existing session).');
    } else {
      try {
        if (cdpBrowser) await cdpBrowser.close();
        else await context.close();
      } catch {
        // ignore
      }
      stopChromeProcess();
    }
  }
})().catch((err) => {
  stopLocalAuthServer();
  stopChromeProcess();
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
