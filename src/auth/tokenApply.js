const { CONFIG } = require('../config/config');
const { screenshot } = require('../utils/helpers');

async function listExtensionIds(context) {
  const ids = new Set();
  for (const w of context.serviceWorkers()) {
    if (w.url().startsWith('chrome-extension://')) {
      ids.add(w.url().split('/')[2]);
    }
  }
  if (CONFIG.browserMode === 'os-chrome' && CONFIG.extensionId) {
    ids.add(CONFIG.extensionId);
  }
  return [...ids];
}

async function getExtensionId(context) {
  const ids = await listExtensionIds(context);
  if (!ids.length) throw new Error('EXTENSION_NOT_AVAILABLE');
  console.log(`Candidate extension id(s): ${ids.join(', ')}`);
  return ids[0];
}

/**
 * Paste token via extension popup fields (triggers chrome.storage.local.set on input).
 * Tries each loaded extension id until Kmart Device Emulator popup is found.
 */
async function pasteTokenIntoExtension(context, token, storeId) {
  console.log('\n[2/4] Updating Auth Token in Kmart Device Emulator extension...');
  const storeValue = String(storeId || CONFIG.extensionStoreId || '');
  const storeServer = CONFIG.extensionStoreServer || '';

  // Wait briefly for SW registration
  for (let i = 0; i < 8 && !(await listExtensionIds(context)).length; i++) {
    try {
      await context.waitForEvent('serviceworker', { timeout: 1500 });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const extensionIds = await listExtensionIds(context);
  if (!extensionIds.length) throw new Error('EXTENSION_NOT_AVAILABLE');

  let lastErr = null;
  for (const extensionId of extensionIds) {
    const popup = await context.newPage();
    try {
      console.log(`Trying extension popup: ${extensionId}`);
      await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      await popup.waitForTimeout(400);

      const tokenInput = popup.locator('#kmart-emulator-auth-token');
      if (!(await tokenInput.isVisible({ timeout: 2000 }).catch(() => false))) {
        throw new Error('not kmart emulator popup');
      }

      const storeIdInput = popup.locator('#kmart-emulator-store-id');
      const storeServerInput = popup.locator('#kmart-emulator-store-server');

      await tokenInput.click({ clickCount: 3 });
      await tokenInput.fill(String(token));
      await tokenInput.dispatchEvent('input');

      await storeIdInput.fill('');
      await storeIdInput.fill(storeValue);
      await storeIdInput.dispatchEvent('input');

      if (storeServer && (await storeServerInput.isVisible().catch(() => false))) {
        await storeServerInput.fill('');
        await storeServerInput.fill(storeServer);
        await storeServerInput.dispatchEvent('input');
      }

      await popup.evaluate(
        async ({ tokenValue, storeValue, storeServer }) => {
          const data = {
            kmartDeviceAuthToken: tokenValue,
            kmartDeviceStoreId: storeValue,
          };
          if (storeServer) data.kmartDeviceStoreServer = storeServer;
          await chrome.storage.local.set(data);
        },
        { tokenValue: token, storeValue, storeServer }
      );

      const saved = await popup.evaluate(async () => {
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
      await screenshot(popup, 'extension_token_pasted');
      await popup.close().catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      await popup.close().catch(() => {});
    }
  }

  throw new Error(lastErr?.message || 'EXTENSION_NOT_AVAILABLE');
}

// Fallback when extension cannot be loaded — same Config payload the extension sends
async function injectTokenLikeExtension(page, token, storeId) {
  console.log('\n[2/4] Extension not available — injecting token like extension Config message...');
  const storeValue = String(storeId || CONFIG.extensionStoreId || '');

  await page.routeWebSocket(/localhost:7555|127\.0\.0\.1:7555/, (ws) => {
    const sendConfig = () => {
      const body = {
        storeServerUrl: CONFIG.extensionStoreServer || '',
        apiAuthToken: token,
        token,
        storeId: storeValue,
        teamMemberId: '',
        firstName: 'Alex',
        lastName: 'Bailey',
      };
      ws.send(JSON.stringify({ className: 'Config', payload: body }));
      ws.send(JSON.stringify({ ClassName: 'Config', Payload: body }));
    };
    ws.onMessage((message) => {
      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : null;
        if (
          parsed &&
          (parsed.className === 'Connect' ||
            parsed.ClassName === 'Connect' ||
            parsed.className === 'config' ||
            parsed.ClassName === 'config')
        ) {
          sendConfig();
        }
      } catch {
        // ignore
      }
    });
    setTimeout(sendConfig, 200);
    setTimeout(sendConfig, 800);
    setTimeout(sendConfig, 2000);
  });

  console.log('Token inject route ready (ws://localhost:7555 Config).');
}

async function ensureOpenPage(context, page) {
  if (page && !page.isClosed()) return page;
  const existing = context.pages().find((p) => p && !p.isClosed());
  if (existing) return existing;
  return context.newPage();
}

async function applyToken(context, page, token, mode) {
  const target = await ensureOpenPage(context, page);
  if (mode === 'inject') {
    await injectTokenLikeExtension(target, token, CONFIG.extensionStoreId);
    return 'inject';
  }
  try {
    await pasteTokenIntoExtension(context, token, CONFIG.extensionStoreId);
    return 'extension';
  } catch (err) {
    console.warn(`Extension paste failed (${err.message}) — using inject fallback.`);
    const fallbackPage = await ensureOpenPage(context, target);
    await injectTokenLikeExtension(fallbackPage, token, CONFIG.extensionStoreId);
    return 'inject';
  }
}

module.exports = {
  getExtensionId,
  pasteTokenIntoExtension,
  injectTokenLikeExtension,
  applyToken,
};
