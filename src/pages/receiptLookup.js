const { CONFIG } = require('../config/config');
const {
  screenshot,
  MONTH_NAMES,
  parseDateParts,
  endDateWithDiff,
} = require('../utils/helpers');
const { refreshTokenIfNeeded } = require('../auth/localAuth');

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

  const storeKey = String(storeNameOrNumber).trim();

  // Open dropdown and type store number (retry once — token/WS may arrive late)
  for (let attempt = 1; attempt <= 2; attempt++) {
    await storeInput.click();
    await storeInput.fill('');
    await page.waitForTimeout(300);
    await storeInput.type(storeKey, { delay: 80 });
    console.log(
      `Typed store "${storeKey}" (attempt ${attempt}) — waiting for dropdown (needs auth token)...`
    );

    const loading = page.getByText('Loading stores...');
    if (await loading.isVisible({ timeout: 2500 }).catch(() => false)) {
      console.log('Store list loading...');
      await loading.waitFor({ state: 'hidden', timeout: 45000 }).catch(() => {});
    }

    const noStores = page.getByText(/No stores found/i);
    if (await noStores.isVisible({ timeout: 2500 }).catch(() => false)) {
      await screenshot(page, 'store_no_stores_found');
      if (attempt === 1) {
        console.warn('No stores found — waiting for token/WS, then retrying store search...');
        await page.waitForTimeout(3000);
        // Blur + re-open to trigger a fresh search
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }
      throw new Error(
        `Store "${storeKey}" returned "No stores found" in Receipt Lookup.\n` +
          'This store is not in the KLUE pilot store list for the current PDT token.\n' +
          'Fix: use a pilot store that appears in the dropdown (e.g. 1002).\n' +
          'Digital receipt search may still work without selecting a store.'
      );
    }

    const storeOption = page
      .getByRole('option')
      .filter({ hasText: new RegExp(storeKey) })
      .first();

    if (await storeOption.isVisible({ timeout: 20000 }).catch(() => false)) {
      const optionText = (await storeOption.innerText()).trim();
      console.log(`Dropdown ready — selecting: "${optionText}"`);
      await storeOption.click();
      await page.waitForTimeout(2000);

      const selectedValue = await storeInput.inputValue();
      const current = selectedValue || (await storeInput.innerText().catch(() => '')) || '';
      if (!String(current).includes(storeKey) && !optionText.includes(storeKey)) {
        throw new Error(`Store "${storeKey}" was not selected from dropdown`);
      }

      console.log(`Store selected: ${selectedValue || optionText}`);
      console.log('Waiting before Search...');
      await page.waitForTimeout(2000);
      return;
    }

    if (attempt === 1) {
      console.warn('Store option not visible yet — retrying...');
      await page.waitForTimeout(2000);
    }
  }

  // Dump whatever options are visible to help debug
  const options = await page.getByRole('option').allTextContents().catch(() => []);
  throw new Error(
    `Store "${storeKey}" option never appeared in dropdown.\n` +
      `Visible options: ${options.length ? options.slice(0, 15).join(' | ') : '(none)'}`
  );
}

async function fillDigitalReceiptNumber(page, digitalReceiptNumber) {
  console.log(`Digital Receipt Number: ${digitalReceiptNumber}`);
  const input = page.locator('#digital-receipt-number-field, input[placeholder*="1382" i]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await typeInto(page, input, digitalReceiptNumber);
}

/** Negative: expect the orange "No Receipts Found" banner after Search. */
async function assertNoReceiptsFoundPopup(page) {
  const { EXPECTED_MESSAGES } = require('../assertions/expectedMessages');
  const expected = EXPECTED_MESSAGES.noReceiptsFound;
  console.log(`Expecting negative popup: "${expected.title}"...`);
  const title = page.getByText(expected.titlePattern).first();
  const detail = page.getByText(expected.detailPattern).first();

  await title.waitFor({ state: 'visible', timeout: 45000 });
  const detailVisible = await detail.isVisible({ timeout: 5000 }).catch(() => false);

  await screenshot(page, 'negative_no_receipts_found');

  if (!detailVisible) {
    throw new Error(
      `Saw "${expected.title}" but missing detail text "${expected.detail}"`
    );
  }

  console.log('PASS — matched error popup:');
  console.log(`  • ${expected.title}`);
  console.log(`  • ${expected.detail}`);
  return {
    matched: true,
    title: expected.title,
    detail: expected.detail,
  };
}

/**
 * Read whether a calendar day button is disabled (MuiPickersDay).
 * @returns {'enabled'|'disabled'|'missing'}
 */
async function calendarDayState(page, day, monthName, year) {
  const calendar = page.locator('.MuiPickersLayout-root, .MuiDateCalendar-root').last();
  await calendar.waitFor({ state: 'visible', timeout: 8000 });
  const dayStr = String(day);
  const monthShort = monthName.slice(0, 3).toLowerCase();

  return calendar.evaluate(
    (el, { dayText, yearText, monthShortText }) => {
      const buttons = [
        ...el.querySelectorAll('button.MuiPickersDay-root:not(.MuiPickersDay-dayOutsideMonth)'),
      ];
      const match = buttons.find((b) => {
        const text = (b.textContent || '').trim();
        if (text !== dayText) return false;
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (aria) {
          if (!aria.includes(String(yearText))) return false;
          if (!aria.includes(monthShortText)) return false;
        }
        return true;
      });
      if (!match) return 'missing';
      const disabled =
        match.disabled ||
        match.getAttribute('disabled') != null ||
        match.getAttribute('aria-disabled') === 'true' ||
        /Mui-disabled/i.test(match.className || '');
      return disabled ? 'disabled' : 'enabled';
    },
    { dayText: dayStr, yearText: String(year), monthShortText: monthShort }
  );
}

/**
 * Negative: after Start is picked, End calendar allows only a 5-day inclusive window
 * (Start … Start+4 enabled; Start+5 and beyond disabled).
 */
async function assertDateRangeLimit(page, startDate) {
  const start = parseDateParts(startDate);
  const lastAllowed = parseDateParts(endDateWithDiff(startDate, 4)); // start+4
  const firstBlocked = parseDateParts(endDateWithDiff(startDate, 5)); // start+5

  console.log(
    `Expecting End calendar 5-day window from ${startDate}: ` +
      `${lastAllowed.day}/${String(lastAllowed.month).padStart(2, '0')} enabled, ` +
      `${firstBlocked.day}/${String(firstBlocked.month).padStart(2, '0')} disabled...`
  );

  await selectDateFromPicker(page, 'Start date', startDate);
  await page.waitForTimeout(500);

  await openDatePicker(page, 'End date');
  await navigateCalendarToMonth(page, lastAllowed.monthName, lastAllowed.year);

  const allowedState = await calendarDayState(
    page,
    lastAllowed.day,
    lastAllowed.monthName,
    lastAllowed.year
  );
  console.log(
    `  Day ${lastAllowed.day} ${lastAllowed.monthName} ${lastAllowed.year} (last allowed): ${allowedState}`
  );

  // May need to move month if blocked day is next month
  if (
    firstBlocked.month !== lastAllowed.month ||
    firstBlocked.year !== lastAllowed.year
  ) {
    await navigateCalendarToMonth(page, firstBlocked.monthName, firstBlocked.year);
  }

  const blockedState = await calendarDayState(
    page,
    firstBlocked.day,
    firstBlocked.monthName,
    firstBlocked.year
  );
  console.log(
    `  Day ${firstBlocked.day} ${firstBlocked.monthName} ${firstBlocked.year} (outside window): ${blockedState}`
  );

  await screenshot(page, 'negative_date_range_limit');

  // Optional helper / hint text near date fields
  const hint = page
    .getByText(/5\s*-?\s*day|maximum.*(5|five).*day|date.{0,20}(range|window)|within.{0,20}5/i)
    .first();
  const hintText = (await hint.isVisible({ timeout: 1500 }).catch(() => false))
    ? ((await hint.innerText().catch(() => '')) || '').trim()
    : null;
  if (hintText) console.log(`  Hint/message: "${hintText}"`);

  await page.keyboard.press('Escape').catch(() => {});

  if (allowedState === 'missing') {
    throw new Error(
      `Could not find last-allowed End day ${lastAllowed.day} ${lastAllowed.monthName} ${lastAllowed.year} on calendar.`
    );
  }
  if (allowedState !== 'enabled') {
    throw new Error(
      `Expected last day of 5-day window (${lastAllowed.day} ${lastAllowed.monthName}) to be ENABLED, got ${allowedState}.`
    );
  }
  if (blockedState === 'missing') {
    throw new Error(
      `Could not find out-of-range End day ${firstBlocked.day} ${firstBlocked.monthName} ${firstBlocked.year} on calendar.`
    );
  }
  if (blockedState !== 'disabled') {
    throw new Error(
      `Expected day outside 5-day window (${firstBlocked.day} ${firstBlocked.monthName}) to be DISABLED, got ${blockedState}.`
    );
  }

  console.log('PASS — End calendar enforces 5-day window (in-range enabled, out-of-range disabled).');
  return {
    matched: true,
    title: 'Date range limited to 5 days',
    detail: hintText || `${startDate} → +4d enabled, +5d disabled`,
    startDate,
    lastAllowed: endDateWithDiff(startDate, 4),
    firstBlocked: endDateWithDiff(startDate, 5),
    hintText,
  };
}

/**
 * Negative: amount max−min outside $1–$5 shows error/warning helper text.
 */
async function assertAmountRangeWarning(page, amountFrom, amountTo) {
  const from = parseFloat(amountFrom);
  const to = parseFloat(amountTo);
  const diff = Math.abs(to - from);
  console.log(
    `Expecting amount validation for ${amountFrom} → ${amountTo} (diff $${diff.toFixed(2)}; allowed $1–$5)...`
  );

  await fillAmountRange(page, amountFrom, amountTo);
  // Blur so MUI / form validation runs
  await page.locator('#purchaseTotalAmount-max').press('Tab').catch(() => {});
  await page.waitForTimeout(800);

  const messagePatterns = [
    require('../assertions/expectedMessages').EXPECTED_MESSAGES.amountRangeLimit.pattern,
    /amount.{0,40}(1|\$\s*1).{0,20}(5|\$\s*5)/i,
    /difference.{0,40}(1|\$\s*1).{0,20}(5|\$\s*5)/i,
    /(must|should).{0,30}(between|within).{0,30}(\$\s*)?1.{0,15}(\$\s*)?5/i,
    /(maximum|max).{0,30}(\$\s*)?5/i,
    /(minimum|min).{0,30}(\$\s*)?1/i,
    /amount.{0,40}(range|difference|span).{0,40}(invalid|error|exceed|too (large|small|wide)|not allowed)/i,
    /total.{0,30}(range|amount).{0,40}(1|5|\$)/i,
  ];

  let matchedText = null;
  for (const re of messagePatterns) {
    const loc = page.getByText(re).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      matchedText = ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (matchedText) break;
    }
  }

  // Fallback: any MUI helper / alert near the amount inputs
  if (!matchedText) {
    const helpers = page.locator(
      '.MuiFormHelperText-root, [role="alert"], .Mui-error, p.MuiFormHelperText-root'
    );
    const count = await helpers.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = helpers.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/amount|total|\$|difference|range|1|5/i.test(text)) {
        matchedText = text;
        break;
      }
    }
  }

  const minInvalid = await page
    .locator('#purchaseTotalAmount-min')
    .evaluate((el) => el.getAttribute('aria-invalid') === 'true')
    .catch(() => false);
  const maxInvalid = await page
    .locator('#purchaseTotalAmount-max')
    .evaluate((el) => el.getAttribute('aria-invalid') === 'true')
    .catch(() => false);

  const searchBtn = page.getByRole('button', { name: /^Search$/i }).first();
  const searchDisabled =
    (await searchBtn.isDisabled().catch(() => false)) ||
    (await searchBtn.getAttribute('disabled').then((v) => v != null).catch(() => false)) ||
    (await searchBtn
      .evaluate((el) => el.getAttribute('aria-disabled') === 'true' || /Mui-disabled/i.test(el.className || ''))
      .catch(() => false));

  await screenshot(page, 'negative_amount_range_limit');

  if (!matchedText && !minInvalid && !maxInvalid && !searchDisabled) {
    throw new Error(
      `No amount validation message, aria-invalid, or disabled Search for span $${diff.toFixed(
        2
      )} (expected error when outside $1–$5).`
    );
  }

  console.log('PASS — amount range validation shown:');
  if (matchedText) console.log(`  • message: "${matchedText}"`);
  if (minInvalid || maxInvalid) {
    console.log(`  • aria-invalid min=${minInvalid} max=${maxInvalid}`);
  }
  if (searchDisabled) console.log('  • Search button disabled');

  return {
    matched: true,
    title: 'Amount range validation',
    detail:
      matchedText ||
      (searchDisabled
        ? 'Search disabled'
        : `aria-invalid (min=${minInvalid}, max=${maxInvalid})`),
    amountFrom,
    amountTo,
    difference: diff,
    message: matchedText,
  };
}

/**
 * Negative: type a store that the API does not return and expect "No stores found".
 * Does not throw — returns match result (caller decides PASS/FAIL).
 */
async function assertNoStoresFound(page, storeNameOrNumber) {
  const { EXPECTED_MESSAGES } = require('../assertions/expectedMessages');
  const expected = EXPECTED_MESSAGES.noStoresFound;
  const storeKey = String(storeNameOrNumber).trim();
  console.log(`Expecting negative store message for "${storeKey}": "${expected.text}"...`);

  const storeInput = page.locator('#store-select');
  await storeInput.waitFor({ state: 'visible', timeout: 15000 });
  await storeInput.click();
  await storeInput.fill('');
  await page.waitForTimeout(300);
  await storeInput.type(storeKey, { delay: 80 });

  const loading = page.getByText('Loading stores...');
  if (await loading.isVisible({ timeout: 2500 }).catch(() => false)) {
    await loading.waitFor({ state: 'hidden', timeout: 45000 }).catch(() => {});
  }

  const noStores = page.getByText(expected.pattern).first();
  await noStores.waitFor({ state: 'visible', timeout: 20000 });
  await screenshot(page, 'negative_no_stores_found');

  console.log('PASS — matched store API empty result:');
  console.log(`  • ${expected.text}`);
  return {
    matched: true,
    message: expected.text,
    store: storeKey,
  };
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
  const empty = page
    .getByText(
      /No Receipts Found|No receipts|0\s+Receipts|No results|couldn't find|could not find|not found|refining your search/i
    )
    .first();
  const cards = receiptResultCards(page);
  const authError = page.getByText(/unauthoriz|forbidden|token|sign in|session/i).first();

  const raced = await Promise.race([
    heading.waitFor({ state: 'visible', timeout: remaining }).then(() => 'heading'),
    empty.waitFor({ state: 'visible', timeout: remaining }).then(() => 'empty'),
    cards.first().waitFor({ state: 'visible', timeout: remaining }).then(() => 'cards'),
    page
      .getByText(/Kmart\s+\w[\w\s]*\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i)
      .first()
      .waitFor({ state: 'visible', timeout: remaining })
      .then(() => 'storeLine'),
    authError.waitFor({ state: 'visible', timeout: Math.min(8000, remaining) }).then(() => 'auth'),
  ]).catch(() => null);

  if (!raced) {
    await screenshot(page, 'receipt_results_timeout');
    throw new Error(
      `Timed out waiting for receipt results (url=${page.url()}). Check token / receipt exists in this env.`
    );
  }

  if (raced === 'empty') {
    await screenshot(page, 'receipt_results_empty');
    throw new Error('Receipt search returned no receipts for the current criteria/token.');
  }
  if (raced === 'auth') {
    await screenshot(page, 'receipt_results_auth_error');
    throw new Error('Receipt search hit an auth/session error — token may not be applied.');
  }

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

/** After Search: open first receipt report/document. Leaves it open for Sumo check. */
async function openReceiptDocument(page) {
  console.log('\nOpening first receipt report from the results list...');

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
    page
      .getByText(/Tax Invoice|Total Items|SALE:/i)
      .first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .then(() => true)
      .catch(() => false),
  ]);

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
  await page
    .getByText(/\$\d+|Receipt Number|Kmart|Item|Total|Tax|Qty|SALE:/i)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => console.warn('Receipt body content still empty after wait — continuing.'));
  await page.waitForTimeout(1000);
  await screenshot(page, 'receipt_document_open');
  console.log('Receipt report/document is open — next step: open Sumo logs and verify.');

  return { uiReceiptCount, uiReceipts };
}

/** After Sumo check: New Search + close Receipt Lookup tab. */
async function closeReceiptLookupAfterView(page) {
  if (!page || page.isClosed()) return;

  const viewSeconds = Math.max(CONFIG.receiptViewSeconds || 10, 8);
  console.log(`Keeping receipt detail open for ${viewSeconds}s before New Search...`);
  await page.waitForTimeout(viewSeconds * 1000).catch(() => {});

  const newSearchBtn = page
    .getByRole('button', { name: /New Search/i })
    .or(page.getByText(/^New Search$/i))
    .first();
  if (await newSearchBtn.isVisible({ timeout: 20000 }).catch(() => false)) {
    await newSearchBtn.click();
    console.log('Clicked New Search.');
    await page.waitForTimeout(1500);
    await screenshot(page, 'receipt_new_search');
  } else {
    console.warn('New Search button not found — continuing.');
    await screenshot(page, 'receipt_new_search_missing').catch(() => {});
  }

  console.log('Closing Receipt Lookup window...');
  await page.close().catch(async () => {
    await page.goto('about:blank').catch(() => {});
  });
}

/** @deprecated Use openReceiptDocument then Sumo then closeReceiptLookupAfterView. */
async function openReceiptDocumentThenClose(page) {
  const result = await openReceiptDocument(page);
  await closeReceiptLookupAfterView(page);
  return result;
}

async function performReceiptLookup(page, context, tokenHolder) {
  await openReceiptLookup(page);
  await selectTab(page, CONFIG.searchMode);

  // ── Negative scenarios (assert error UI, then stop — no Sumo / no open receipt) ──
  if (CONFIG.expectNegative === 'noReceipts') {
    if (CONFIG.searchMode === 'byDigitalReceiptNumber') {
      if (!CONFIG.digitalReceiptNumber) {
        throw new Error('expectNegative=noReceipts requires digitalReceiptNumber');
      }
      await fillDigitalReceiptNumber(page, CONFIG.digitalReceiptNumber);
    } else {
      const d = CONFIG.byDetails || {};
      await fillDateRange(page, d.startDate, d.endDate);
      await fillAmountRange(page, d.amountFrom, d.amountTo);
      await fillIdentifyBy(page, d);
      if (context && tokenHolder && tokenHolder.value) {
        await refreshTokenIfNeeded(context, tokenHolder);
      }
      await fillStore(page, d.storeNameOrNumber);
    }
    await screenshot(page, 'receipt_lookup_filled');
    await page.waitForTimeout(800);

    console.log('Clicking Search (expect No Receipts Found)...');
    const searchBtn = page.getByRole('button', { name: /^Search$/i });
    await searchBtn.waitFor({ state: 'visible', timeout: 10000 });
    await searchBtn.click();

    const popup = await assertNoReceiptsFoundPopup(page);
    return {
      uiReceiptCount: 0,
      uiReceipts: [],
      negative: { type: 'noReceipts', ...popup },
    };
  }

  if (CONFIG.expectNegative === 'noStores') {
    const d = CONFIG.byDetails || {};
    await fillDateRange(page, d.startDate, d.endDate);
    await fillAmountRange(page, d.amountFrom, d.amountTo);
    await fillIdentifyBy(page, d);
    if (context && tokenHolder && tokenHolder.value) {
      await refreshTokenIfNeeded(context, tokenHolder);
    }
    const storeResult = await assertNoStoresFound(page, d.storeNameOrNumber);
    await screenshot(page, 'receipt_lookup_filled');
    return {
      uiReceiptCount: 0,
      uiReceipts: [],
      negative: { type: 'noStores', ...storeResult },
    };
  }

  if (CONFIG.expectNegative === 'dateRange') {
    const d = CONFIG.byDetails || {};
    if (!d.startDate) {
      throw new Error('expectNegative=dateRange requires byDetails.startDate');
    }
    const dateResult = await assertDateRangeLimit(page, d.startDate);
    await screenshot(page, 'receipt_lookup_filled');
    return {
      uiReceiptCount: 0,
      uiReceipts: [],
      negative: { type: 'dateRange', ...dateResult },
    };
  }

  if (CONFIG.expectNegative === 'amountRange') {
    const d = CONFIG.byDetails || {};
    if (d.amountFrom == null || d.amountTo == null) {
      throw new Error('expectNegative=amountRange requires byDetails.amountFrom and amountTo');
    }
    const amountResult = await assertAmountRangeWarning(page, d.amountFrom, d.amountTo);
    await screenshot(page, 'receipt_lookup_filled');
    return {
      uiReceiptCount: 0,
      uiReceipts: [],
      negative: { type: 'amountRange', ...amountResult },
    };
  }

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
  // Leave receipt report open — flow opens Sumo next, then closes this tab.
  const result = await openReceiptDocument(page);
  return {
    uiReceiptCount: result?.uiReceiptCount ?? null,
    uiReceipts: result?.uiReceipts || [],
    receiptPage: page,
  };
}

module.exports = {
  openReceiptLookup,
  selectTab,
  typeInto,
  openDatePicker,
  getVisibleCalendarMonthYear,
  navigateCalendarToMonth,
  clickCalendarDay,
  readDateInputValue,
  selectDateFromPicker,
  fillDateRange,
  fillAmountRange,
  fillIdentifyBy,
  fillStore,
  fillDigitalReceiptNumber,
  assertNoReceiptsFoundPopup,
  assertNoStoresFound,
  assertDateRangeLimit,
  assertAmountRangeWarning,
  receiptResultCards,
  waitForReceiptResults,
  submitReceiptSearch,
  countReceiptsOnResultsPage,
  captureUiReceiptCards,
  openReceiptDocument,
  closeReceiptLookupAfterView,
  openReceiptDocumentThenClose,
  performReceiptLookup,
};
