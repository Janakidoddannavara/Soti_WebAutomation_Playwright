const path = require('path');
const fs = require('fs');
const { CONFIG } = require('../config/config');

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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseDateParts(dateStr) {
  const [dd, mm, yyyy] = dateStr.split('/').map((p) => parseInt(p, 10));
  return { day: dd, month: mm, year: yyyy, monthName: MONTH_NAMES[mm - 1] };
}

function formatDdMmYyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

function endDateWithDiff(startDateStr, dayDiff = 4) {
  const { day, month, year } = parseDateParts(startDateStr);
  const d = new Date(year, month - 1, day);
  d.setDate(d.getDate() + dayDiff);
  return formatDdMmYyyy(d);
}

function ddMmYyyyToIso(dateStr) {
  const { day, month, year } = parseDateParts(dateStr);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = {
  ensureDir,
  timestamp,
  screenshot,
  fillVisibleInput,
  MONTH_NAMES,
  parseDateParts,
  formatDdMmYyyy,
  endDateWithDiff,
  ddMmYyyyToIso,
};
