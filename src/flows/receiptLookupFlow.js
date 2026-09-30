const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config/config');
const { state } = require('../core/state');
const { ensureDir, screenshot } = require('../utils/helpers');
const {
  launchBrowserWithExtensions,
  stopChromeProcess,
  cleanupBrowser,
} = require('../core/browser');
const { signInAndCaptureToken, stopLocalAuthServer } = require('../auth/localAuth');
const { applyToken } = require('../auth/tokenApply');
const {
  performReceiptLookup,
  closeReceiptLookupAfterView,
} = require('../pages/receiptLookup');
const { loginToSumo, runSumoQuery, buildSumoQuery } = require('../pages/sumo');

/**
 * Receipt Lookup + Sumo Logic end-to-end flow.
 * Steps: auth → apply token → search → open receipt report → Sumo check → close receipt.
 * @returns {{ ok: boolean, error?: string }}
 */
async function runReceiptLookupFlow() {
  ensureDir(CONFIG.outputDir);
  let result = { ok: true };

  if (CONFIG.activeScenario) {
    console.log(`Active scenario: ${CONFIG.activeScenario}`);
  }

  if (!fs.existsSync(CONFIG.extensionPath) && CONFIG.browserMode !== 'inject') {
    console.warn(
      `Extension folder not found at ${CONFIG.extensionPath} — will use inject fallback if needed.`
    );
  }

  // Clear stale profile locks (legacy + current profiles)
  for (const dirName of ['user-data-sumo', 'user-data-receipt-lookup']) {
    const lockDir = path.join(process.cwd(), dirName);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        fs.unlinkSync(path.join(lockDir, f));
      } catch {
        // ignore
      }
    }
  }

  let context;
  let page;
  let mode;
  try {
    ({ context, page, mode } = await launchBrowserWithExtensions());
  } catch (err) {
    await cleanupBrowser();
    return { ok: false, error: err.message };
  }

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

    // 3) Receipt Lookup — search, open receipt report (leave open for Sumo)
    let uiReceiptCount = null;
    let uiReceipts = [];
    let negativeResult = null;
    let receiptPage = null;
    if (CONFIG.runReceiptLookup) {
      const receiptResult = await performReceiptLookup(page, context, tokenHolder);
      uiReceiptCount = receiptResult?.uiReceiptCount ?? null;
      uiReceipts = receiptResult?.uiReceipts || [];
      negativeResult = receiptResult?.negative || null;
      receiptPage = receiptResult?.receiptPage || page;
      if (negativeResult) {
        console.log(
          `\nNegative assertion OK (${negativeResult.type}): ${
            negativeResult.title || negativeResult.message || 'matched'
          }`
        );
      }
    } else {
      console.log('\n[3/4] Receipt Lookup skipped (CONFIG.runReceiptLookup = false).');
    }

    // 4) Sumo Logic — once the receipt report is open, open Sumo and verify
    //    (card / flybuys / onepass / digital). Skip negatives and auth-token-only.
    const skipSumo = Boolean(CONFIG.expectNegative || negativeResult || CONFIG.runSumoCheck === false);

    if (skipSumo) {
      console.log('\n[4/4] Sumo check skipped (negative scenario or runSumoCheck=false).');
      if (receiptPage && !negativeResult && CONFIG.runReceiptLookup) {
        await closeReceiptLookupAfterView(receiptPage);
      }
    } else if (CONFIG.runReceiptLookup || CONFIG.runSumoCheck) {
      const identifyLabel =
        CONFIG.searchMode === 'byDigitalReceiptNumber'
          ? 'digital receipt number'
          : (CONFIG.byDetails && CONFIG.byDetails.identifyBy) || 'details';
      console.log(
        `\n[4/4] Receipt report is open — opening Sumo logs to verify (${identifyLabel})...`
      );
      const sumoPage = await context.newPage();
      await loginToSumo(sumoPage);
      const query =
        (CONFIG.sumoQuery && CONFIG.sumoQuery.trim()) ||
        buildSumoQuery(CONFIG.env, CONFIG.serviceLayer);
      const sumoResult = await runSumoQuery(sumoPage, query, uiReceiptCount, uiReceipts);
      console.log(
        `\nSumo compare: UI=${sumoResult.uiReceiptCount} Found=${sumoResult.sumoFoundReceipts} OK=${sumoResult.compareOk}`
      );

      // After Sumo check: New Search + close the receipt tab
      if (receiptPage && CONFIG.runReceiptLookup) {
        console.log('\nSumo check done — closing Receipt Lookup tab...');
        await closeReceiptLookupAfterView(receiptPage);
      }
    } else {
      console.log('\n[4/4] Sumo check skipped.');
    }

    console.log('\n─── Summary ───');
    if (CONFIG.activeScenario) console.log(`Scenario     : ${CONFIG.activeScenario}`);
    console.log(`Token applied via: ${appliedVia}`);
    console.log(`Search mode  : ${CONFIG.searchMode}`);
    if (CONFIG.searchMode === 'byDigitalReceiptNumber') {
      console.log(`Digital RN   : ${CONFIG.digitalReceiptNumber}`);
    } else {
      const d = CONFIG.byDetails || {};
      console.log(`Store        : ${d.storeNameOrNumber}`);
      console.log(`Dates        : ${d.startDate} → ${d.endDate}`);
      console.log(`Amount       : ${d.amountFrom} → ${d.amountTo}`);
      console.log(`Identify by  : ${d.identifyBy}`);
      if (d.identifyBy === 'flybuys') console.log(`Flybuys      : ${d.flybuysId}`);
      else if (d.identifyBy === 'onepass') console.log(`OnePass      : ${d.onepassId}`);
      else console.log(`Card         : ${d.cardLastThree}`);
    }
    console.log(`UI receipts  : ${uiReceiptCount}`);
    if (negativeResult) {
      console.log(`Negative     : ${negativeResult.type}`);
      if (negativeResult.title) console.log(`  title       : ${negativeResult.title}`);
      if (negativeResult.detail) console.log(`  detail      : ${negativeResult.detail}`);
      if (negativeResult.message) console.log(`  message     : ${negativeResult.message}`);
    }
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
      await anyPage.waitForTimeout(CONFIG.keepOpenSeconds * 1000).catch(
        () => new Promise((r) => setTimeout(r, CONFIG.keepOpenSeconds * 1000))
      );
    }
  } catch (err) {
    console.error('\nAutomation failed:', err.message);
    result = { ok: false, error: err.message };
    const errPage = context.pages()[0];
    if (errPage) await screenshot(errPage, 'error_state').catch(() => {});
    const holdSeconds = CONFIG.batchMode
      ? 0
      : Math.max(CONFIG.keepOpenSeconds || 0, 60);
    if (holdSeconds > 0) {
      console.error('\nBrowser will stay open so you can check.');
      console.log(`Keeping browser open for ${holdSeconds}s...`);
      await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    }
    process.exitCode = 1;
  } finally {
    stopLocalAuthServer();
    if (state.attachedToExistingChrome) {
      console.log('Left your Chrome open (attached to existing session).');
    } else {
      await cleanupBrowser();
    }
  }

  return result;
}

module.exports = { runReceiptLookupFlow };
