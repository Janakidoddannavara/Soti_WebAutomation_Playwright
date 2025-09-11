process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});


const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EMAIL = 'janaki.doddannavara@anko.com';  // replace with your user name
const PASSWORD = 'Qakas@22july';        // replace with your password

(async () => {
  const context = await chromium.launchPersistentContext('./user-data', {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
    acceptDownloads: true
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to dashboard');
  await page.goto('https://a0010848.mobicontrol.cloud/MobiControl/WebConsole/home/dashboard/device');

  // Login
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', PASSWORD);
    await page.getByRole('button', { name: /Sign in|Submit/i }).click();
    console.log('Submitted login info..');
  } catch {
    console.log('Login not needed, already authenticated.');
  }

  try {
    console.log('Waiting for dashboard to load');
    await page.waitForURL(url => url.includes('/home/dashboard/devices'), { timeout: 60000 });
    await page.waitForSelector('text=Devices', { timeout: 20000 });
    console.log('Dashboard loaded successfully!');
  } catch {
    console.error('Timed out waiting for dashboard.');
  }

  // Clear filters
  /*await page.locator('.TailCursorContent').click();
  await page.locator('.TailCursor').click();
  await page.locator('.TailCursorContent').click();
  await page.getByText('Store Number').click();
  await page.locator('.DeleteButton').first().click();
  console.log('Cleared old details');

  // Apply filter
  await page.locator('span').filter({ hasText: 'Search for Devices' }).nth(1).click();
  await page.locator('category-wrapper soti-dropdown-node').filter({ hasText: 'Device' }).click();
  //await page.locator('soti-dropdown-node').filter({ hasText: 'Store Number' }).click();
  //await page.locator('soti-dropdown-node').filter({ hasText: /^is$/ }).click();
  await page.locator('soti-dropdown-node').filter({ hasText: 'DeviceName' }).click();
  await page.locator('soti-dropdown-node').filter({ hasText: /^in$/ }).click();
  await page.waitForTimeout(1000);
  const inputField = page.locator('soti-multiple-inputs div').nth(2);
  await inputField.click();
  await inputField.type('KMPD309196','KMPD307075')({ delay: 200 });
  await page.getByRole('button', { name: 'DONE' }).click(); 
  await page.locator('.query-button-base.search-button').click(); */

  // Wait for device list
  await page.waitForSelector('a.device-name-cell-text pre.device-name-cell-text');
  const deviceRows = await page.locator('mc-row');
  const deviceCount = await deviceRows.count();
  console.log(`Found ${deviceCount} devices`);

  const downloadDir = path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

  for (let i = 0; i < deviceCount; i++) {
    const nameLocator = page.locator(`mc-row:nth-child(${i + 1}) pre.device-name-cell-text`);
    const deviceName = (await nameLocator.innerText()).trim();
    const safeName = deviceName.replace(/[<>:"/\\|?*]/g, '_') || `device_${i + 1}`;
    console.log(`\n Processing device ${i + 1}/${deviceCount}: "${deviceName}"`);

    const selectCell = (i === 0)
      ? page.locator('.mc-cell').first()
      : page.locator(`mc-row:nth-child(${i + 1}) > .mc-cell.cdk-cell.cdk-column-select`);
    await selectCell.click();
    await page.waitForTimeout(500);

    const offlineBtn = page.getByRole('button', { name: 'Remote Control (Offline)' });
    if (await offlineBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log(` Device "${deviceName}" is offline; skipping.`);
      await selectCell.click();
      await page.waitForTimeout(500);
      continue;
    }

    const remoteBtn = page.getByRole('button', { name: 'Remote Control' });
    if (!(await remoteBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
      console.log(` Remote Control button not available for "${deviceName}", skipping.`);
      await selectCell.click();
      await page.waitForTimeout(500);
      continue;
    }

    await remoteBtn.click();
    try { await page.getByRole('button', { name: 'OK' }).click(); } catch {}

    let remote;
    try {
      remote = await page.waitForEvent('popup', { timeout: 10000 });
      await remote.waitForLoadState('networkidle');
    } catch {
      console.log('Remote popup failed. Skipping.');
      await selectCell.click();
      continue;
    }

    await remote.locator('app-work-panel-menu-bar span').nth(2).click();
    console.log('Opened File Manager');

let downloadSuccess = false;

try {
  
  //  Try Fallback first
  await page.waitForTimeout(500);

  await Promise.race([
    remote.locator('#tr2 > .tree-node.max-height.cell-left > div > div > .display-table > .fa.fa-angle-right').click(),
    page.waitForTimeout(3000).then(() => { throw new Error('Fallback expand timeout'); })
  ]);

  console.log('Secondary SD card node clicked.');

  await remote.getByRole('cell', { name: '  StockTakeLogging', exact: true }).click();

  const downloadFallbackPromise = remote.waitForEvent('download');
  await remote.locator('#fileManagerActionBar span').nth(1).click();
  const downloadFallback = await downloadFallbackPromise;

  const suggestedFallback = await downloadFallback.suggestedFilename();
  const extFallback = path.extname(suggestedFallback) || '';
  const newFileNameFallback = `${safeName}${extFallback}`;
  const targetPathFallback = path.join(downloadDir, newFileNameFallback);
  await downloadFallback.saveAs(targetPathFallback);

  console.log(`Downloaded (fallback) and saved as "${newFileNameFallback}"`);
  downloadSuccess = true;

  // ✅ Acknowledge success message
  await remote.locator('div').filter({ hasText: /^StockTakeLogging successfully downloaded\.$/ }).nth(1).click();

} catch (fallbackErr) {
  console.warn(' Fallback expand failed, attempting primary...');


  try {
    // Now attempt Primary expand and download
    await remote.locator('#tr21 > .tree-node.max-height.cell-left > div > div > .display-table > .fa.fa-angle-right').click();
    console.log('Primary SD card node clicked.');

    await remote.getByRole('cell', { name: '   StockTakeLogging', exact: true }).click();

    const downloadPrimaryPromise = remote.waitForEvent('download');
    await remote.locator('.mat-tooltip-trigger.action-bar-button').first().click();
    const downloadPrimary = await downloadPrimaryPromise;

    const suggestedPrimary = await downloadPrimary.suggestedFilename();
    const extPrimary = path.extname(suggestedPrimary) || '';
    const newFileNamePrimary = `${safeName}${extPrimary}`;
    const targetPathPrimary = path.join(downloadDir, newFileNamePrimary);
    await downloadPrimary.saveAs(targetPathPrimary);

    console.log(`Downloaded from primary and saved as "${newFileNamePrimary}"`);
    downloadSuccess = true;

  } catch (primaryErr) {
    console.warn('Primary expand/download also failed:', primaryErr.message);
  }
}

await remote.close();
await page.bringToFront();

if (!downloadSuccess) {
  console.log(`Skipped download for "${deviceName}"`);
}

await selectCell.click();
await page.waitForTimeout(500);
  }

  console.log('\n All device processing completed.');
  await page.waitForTimeout(2000);
  await context.close();
})();
