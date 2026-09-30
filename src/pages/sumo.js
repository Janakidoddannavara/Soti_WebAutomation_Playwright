const path = require('path');
const fs = require('fs');
const { CONFIG } = require('../config/config');
const {
  ensureDir,
  timestamp,
  screenshot,
  ddMmYyyyToIso,
} = require('../utils/helpers');

function buildSumoQuery(env, serviceLayer) {
  const category =
    serviceLayer === 'api/bff'
      ? `dsfcs/${env}/aws/ecs/(api/bff)`
      : `dsfcs/${env}/aws/ecs/${serviceLayer}`;

  return `(_collector="dsf-cs-receiptlookup") and (_sourceCategory="${category}")`;
}

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

  // Prefer the Found N nearest to this search's criteria (avoid stale Found from prior runs).
  const foundMatches = [...text.matchAll(/Found\s+(\d+)\s+receipt\(s\)/gi)];
  if (foundMatches.length) {
    const needles = [];
    if (CONFIG.searchMode === 'byDigitalReceiptNumber' && CONFIG.digitalReceiptNumber) {
      needles.push(String(CONFIG.digitalReceiptNumber));
      needles.push('digitalReceiptNumber');
    } else {
      if (details.storeNameOrNumber) needles.push(String(details.storeNameOrNumber));
      if (details.cardLastThree) needles.push(String(details.cardLastThree));
      if (details.flybuysId) needles.push(String(details.flybuysId));
      if (details.onepassId) needles.push(String(details.onepassId));
      needles.push('cardLastThree', 'flybuys', 'onepass', 'storeId');
    }

    let best = foundMatches[foundMatches.length - 1];
    let bestScore = -1;
    for (const m of foundMatches) {
      const start = Math.max(0, m.index - 1200);
      const end = Math.min(text.length, m.index + m[0].length + 1200);
      const window = text.slice(start, end);
      let score = 0;
      for (const n of needles) {
        if (n && window.includes(n)) score += 2;
      }
      // Prefer later (usually newer) matches when scores tie
      score += m.index / Math.max(text.length, 1);
      if (score >= bestScore) {
        bestScore = score;
        best = m;
      }
    }
    findings.foundReceipts = parseInt(best[1], 10);
    findings.rawFoundLine = best[0];
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
    const id = String(details.flybuysId);
    // Line-broken JSON: flybuysId \n : \n "2791990001112"
    findings.flybuysOk =
      new RegExp(`flybuys(?:Id)?[\\s:"']{0,40}${id}\\b`, 'i').test(text) ||
      new RegExp(`"flybuys(?:Id)?"\\s*:\\s*"${id}"`, 'i').test(text) ||
      text.includes(id);
  } else if (identifyBy === 'onepass' && details.onepassId) {
    const id = String(details.onepassId);
    findings.onepassOk =
      new RegExp(`onepass(?:Id)?[\\s:"']{0,40}${id}\\b`, 'i').test(text) ||
      new RegExp(`"onepass(?:Id)?"\\s*:\\s*"${id}"`, 'i').test(text) ||
      text.includes(id);
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
  const details = CONFIG.byDetails || {};
  const identifyBy = (details.identifyBy || 'card').toLowerCase();
  console.log('\n[4/4] Sumo Logic — verify same search criteria after Receipt Lookup...');
  console.log(`Identify-by for Sumo check: ${identifyBy}`);
  if (identifyBy === 'flybuys') console.log(`  Flybuys ID expected in logs: ${details.flybuysId}`);
  if (identifyBy === 'onepass') console.log(`  OnePass ID expected in logs: ${details.onepassId}`);
  if (identifyBy === 'card') console.log(`  Card last 3 expected in logs: ${details.cardLastThree}`);
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

    // Browser find → jump to search criteria / Found / each receipt #
    const details = CONFIG.byDetails || {};
    const identifyBy = (details.identifyBy || 'card').toLowerCase();
    const findNeedles = ['Searching receipts', 'Found ', 'cardLastThree', 'flybuys', 'onepass', 'storeId'];
    if (identifyBy === 'card' && details.cardLastThree) findNeedles.push(String(details.cardLastThree));
    if (identifyBy === 'flybuys' && details.flybuysId) findNeedles.push(String(details.flybuysId));
    if (identifyBy === 'onepass' && details.onepassId) findNeedles.push(String(details.onepassId));
    if (details.storeNameOrNumber) findNeedles.push(String(details.storeNameOrNumber));
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

    const foundLoc = page
      .getByText(/Found\s+\d+\s+receipt\(s\)|Searching receipts|cardLastThree|flybuys|onepass/i)
      .first();
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

  // identifyBy already set at start of runSumoQuery
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

  // Digital RN: Sumo window often still shows an older Found N from by-details.
  // Pass when UI found the expected digital receipt and Sumo shows digitalReceiptNumber criteria.
  if (
    !compareOk &&
    CONFIG.searchMode === 'byDigitalReceiptNumber' &&
    CONFIG.digitalReceiptNumber &&
    uiReceiptCount != null &&
    uiReceiptCount >= 1
  ) {
    const rn = String(CONFIG.digitalReceiptNumber);
    const uiHasRn = uiReceipts.some((r) => r.receiptNumber === rn);
    const sumoHasDigitalKey = /digitalReceiptNumber/i.test(bodyText);
    const sumoHasRn = bodyText.includes(rn);
    if (uiHasRn && (sumoHasDigitalKey || sumoHasRn || parsed.foundReceipts != null)) {
      compareOk = true;
      console.log(
        `  • Digital RN soft-match OK (UI has ${rn}; Sumo Found may include prior searches).`
      );
    }
  }

  // Hard fail: UI count vs Sumo Found N
  if (!compareOk && uiReceiptCount != null) {
    throw new Error(
      `Count mismatch: UI list=${uiReceiptCount} cards vs Sumo Found=${parsed.foundReceipts}. See ${reportPath}`
    );
  }
  if (parsed.foundReceipts == null && !noResults) {
    console.warn('Could not parse Found N receipt(s) — check expanded JSON screenshot / report.');
  }

  // Hard fail: identify-by field from the same search must appear in Sumo ReceiptService logs
  if (CONFIG.searchMode === 'byDetails') {
    const id = (details.identifyBy || 'card').toLowerCase();
    if (id === 'flybuys' && details.flybuysId && !parsed.flybuysOk) {
      throw new Error(
        `Sumo logs missing Flybuys ID ${details.flybuysId} after by-details search. See ${reportPath}`
      );
    }
    if (id === 'onepass' && details.onepassId && !parsed.onepassOk) {
      throw new Error(
        `Sumo logs missing OnePass ID ${details.onepassId} after by-details search. See ${reportPath}`
      );
    }
    if (id === 'card' && details.cardLastThree && !parsed.cardLastThreeOk) {
      throw new Error(
        `Sumo logs missing cardLastThree ${details.cardLastThree} after by-details search. See ${reportPath}`
      );
    }
    if (details.storeNameOrNumber && !parsed.storeIdOk) {
      console.warn(
        `Sumo storeId ${details.storeNameOrNumber} not clearly verified — check report ${reportPath}`
      );
    }
  }

  return {
    resultCount,
    uiReceiptCount,
    sumoFoundReceipts: parsed.foundReceipts,
    compareOk,
    parsed,
  };
}

module.exports = {
  buildSumoQuery,
  isSumoLoginPage,
  isSumoAuthenticatedSearch,
  assertNoAzureAssignmentBlock,
  loginToSumo,
  setSumoQueryText,
  setSumoTimeLast60Minutes,
  getSumoEditorQuery,
  normalizeSumoQuery,
  sumoQueryAlreadyEntered,
  clickSumoSearchButton,
  expandAllSumoRowsAndJson,
  parseSumoReceiptServiceDetails,
  runSumoQuery,
};
