const { CONFIG } = require('../config/config');

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

module.exports = {
  extractTokenFromBody,
  getJwtExpiryMs,
  isTokenFresh,
  isTokenRequest,
  selectLocalAuthAccount,
  clickSignIn,
  clickSeeProfile,
  attachTokenCapture,
  waitForToken,
};
