const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config/config');
const { ensureDir, timestamp } = require('../utils/helpers');

/**
 * Write suite results to output/reports/ (JSON + markdown).
 * @param {{ label?: string, results: Array<{name:string,ok:boolean,error?:string}> }} suite
 */
function writeSuiteReport(suite) {
  const results = suite.results || [];
  const label = suite.label || 'suite';
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const startedAt = suite.startedAt || null;
  const finishedAt = new Date().toISOString();

  const reportDir = path.join(CONFIG.outputDir || path.join(process.cwd(), 'output'), 'reports');
  ensureDir(reportDir);

  const stamp = timestamp();
  const payload = {
    framework: 'Receipt Lookup Playwright',
    label,
    startedAt,
    finishedAt,
    totals: { total: results.length, passed, failed },
    results,
  };

  const jsonPath = path.join(reportDir, `${stamp}_${label}.json`);
  const mdPath = path.join(reportDir, `${stamp}_${label}.md`);
  const latestJson = path.join(reportDir, 'latest.json');
  const latestMd = path.join(reportDir, 'latest.md');

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(latestJson, JSON.stringify(payload, null, 2));

  const lines = [
    `# ${label} — scenario report`,
    '',
    `- Finished: ${finishedAt}`,
    `- Totals: **${passed} PASS** / **${failed} FAIL** (of ${results.length})`,
    '',
    '| Result | Scenario | Error |',
    '|--------|----------|-------|',
    ...results.map(
      (r) =>
        `| ${r.ok ? 'PASS' : 'FAIL'} | \`${r.name}\` | ${
          r.error ? String(r.error).replace(/\|/g, '\\|').replace(/\n/g, ' ') : ''
        } |`
    ),
    '',
  ];
  const md = lines.join('\n');
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(latestMd, md);

  console.log(`\nReport saved: ${mdPath}`);
  console.log(`Latest report: ${latestMd}`);
  return { jsonPath, mdPath, latestJson, latestMd, ...payload.totals };
}

module.exports = { writeSuiteReport };
