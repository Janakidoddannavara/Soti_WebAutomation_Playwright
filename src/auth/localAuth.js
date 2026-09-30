const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { CONFIG } = require('../config/config');
const { state } = require('../core/state');
const { screenshot } = require('../utils/helpers');
const {
  isTokenFresh,
  isTokenRequest,
  selectLocalAuthAccount,
  clickSignIn,
  clickSeeProfile,
  attachTokenCapture,
  waitForToken,
  getJwtExpiryMs,
} = require('./tokenCapture');
const { pasteTokenIntoExtension } = require('./tokenApply');

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
  state.localAuthServerProcess = spawn('node', ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: '7575' },
    stdio: 'ignore',
    detached: false,
  });
  state.localAuthServerProcess.on('error', (err) => {
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
  if (state.localAuthServerProcess && !state.localAuthServerProcess.killed) {
    try {
      state.localAuthServerProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    state.localAuthServerProcess = null;
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

module.exports = {
  isLocalAuthReachable,
  ensureLocalAuthServer,
  stopLocalAuthServer,
  waitForLocalAuthServer,
  signInAndCaptureToken,
  refreshTokenIfNeeded,
};
