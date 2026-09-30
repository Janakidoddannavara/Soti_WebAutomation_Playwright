/**
 * Entry point — Receipt Lookup + Sumo Logic framework runner.
 *
 * Usage:
 *   npm run receipt-logs
 *   npm run scenario:card
 *   node runners/receiptLookup.js --scenario=byDetails-flybuys
 *   node runners/receiptLookup.js --list
 *   npm run scenarios:all          # positives first, then negatives
 *   npm run scenarios:positive
 *   npm run scenarios:negative
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
});

const {
  DEFAULT_SCENARIO,
  listScenarios,
  listPositiveScenarioNames,
  listNegativeScenarioNames,
  getScenario,
} = require('../src/scenarios');
const { applyScenario, validateScenarioConfig } = require('../src/config/applyScenario');
const { CONFIG } = require('../src/config/config');
const { stopLocalAuthServer } = require('../src/auth/localAuth');
const { stopChromeProcess, cleanupBrowser } = require('../src/core/browser');
const { runReceiptLookupFlow } = require('../src/flows/receiptLookupFlow');
const { writeSuiteReport } = require('../src/reporting/reporter');

function parseArgs(argv) {
  const args = {
    list: false,
    all: false,
    positive: false,
    negative: false,
    scenario: null,
  };
  for (const arg of argv) {
    if (arg === '--list' || arg === '-l') args.list = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--positive' || arg === '--positives') args.positive = true;
    else if (arg === '--negative' || arg === '--negatives') args.negative = true;
    else if (arg.startsWith('--scenario=')) args.scenario = arg.slice('--scenario='.length);
    else if (arg === '--scenario' || arg === '-s') args._expectScenario = true;
    else if (args._expectScenario) {
      args.scenario = arg;
      args._expectScenario = false;
    }
  }
  return args;
}

function printScenarioList() {
  console.log('Available scenarios:\n');
  console.log('── Positive (run first) ──');
  console.log('   Identify-by trio (each: search → open receipt → Sumo cross-verify):');
  let i = 1;
  for (const s of listScenarios().filter((x) => !x.negative)) {
    const tag =
      s.name === 'byDetails-card' ||
      s.name === 'byDetails-flybuys' ||
      s.name === 'byDetails-onepass'
        ? `  ${i++}.`
        : '    ';
    console.log(`${tag} ${s.name}`);
    if (s.description) console.log(`       ${s.description}`);
  }
  console.log('\n── Negative (error / validation messages) ──');
  for (const s of listScenarios().filter((x) => x.negative)) {
    console.log(`  ${s.name}`);
    if (s.description) console.log(`    ${s.description}`);
  }
  console.log(`\nDefault: ${DEFAULT_SCENARIO}`);
  console.log('Run: npm run scenario:<name>  OR  node runners/receiptLookup.js --scenario=<name>');
  console.log(
    'Batch: npm run scenarios:identify | scenarios:all | scenarios:positive | scenarios:negative'
  );
}

async function runOne(scenarioName, { batchMode = false } = {}) {
  const scenario = getScenario(scenarioName);
  applyScenario(scenario);

  if (batchMode) {
    CONFIG.batchMode = true;
    CONFIG.keepOpenSeconds = 0;
  }

  console.log(`\n═══ Scenario: ${scenario.name} ═══`);
  if (scenario.description) console.log(scenario.description);
  console.log(`searchMode=${CONFIG.searchMode} browserMode=${CONFIG.browserMode}`);
  console.log(
    `steps: auth=${CONFIG.runLocalAuth} token=${CONFIG.runExtensionPaste} receipt=${CONFIG.runReceiptLookup} sumo=${CONFIG.runSumoCheck}`
  );

  if (CONFIG.runReceiptLookup) {
    const errors = validateScenarioConfig(CONFIG);
    if (errors.length) {
      return {
        ok: false,
        error: `config invalid: ${errors.join('; ')} (edit src/scenarios/${scenario.name}.js)`,
      };
    }
  }

  await cleanupBrowser();
  const result = await runReceiptLookupFlow();
  await cleanupBrowser();
  return result;
}

async function runNamedList(names, label) {
  console.log(
    `\n▶ ${label}: ${names.length} scenario(s) sequentially (batch mode — no keep-open)...\n`
  );
  const results = [];

  for (const name of names) {
    try {
      const result = await runOne(name, { batchMode: true });
      if (result.ok) {
        console.log(`\n✓ PASS  ${name}`);
        results.push({ name, ok: true });
      } else {
        console.error(`\n✗ FAIL  ${name} — ${result.error || 'unknown error'}`);
        results.push({ name, ok: false, error: result.error || 'unknown error' });
      }
    } catch (err) {
      console.error(`\n✗ FAIL  ${name} — ${err.message || err}`);
      results.push({ name, ok: false, error: err.message || String(err) });
    } finally {
      await cleanupBrowser({ forceKillPort: true, settleMs: 2500 }).catch(() => {});
    }
  }

  return results;
}

function printSummary(results, label = 'suite') {
  console.log('\n═══ Scenario run summary ═══');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  writeSuiteReport({ label, results, startedAt: printSummary._startedAt || null });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/** Positives first, then negatives. */
async function runAll() {
  printSummary._startedAt = new Date().toISOString();
  const positiveNames = listPositiveScenarioNames();
  const negativeNames = listNegativeScenarioNames();
  console.log(
    `Running all scenarios: ${positiveNames.length} positive → then ${negativeNames.length} negative...\n`
  );

  const positiveResults = await runNamedList(positiveNames, 'POSITIVE scenarios');
  console.log('\n── Positive batch done — starting NEGATIVE scenarios ──');
  const negativeResults = await runNamedList(negativeNames, 'NEGATIVE scenarios');

  printSummary([...positiveResults, ...negativeResults], 'all');
}

async function runPositivesOnly() {
  printSummary._startedAt = new Date().toISOString();
  const results = await runNamedList(listPositiveScenarioNames(), 'POSITIVE scenarios');
  printSummary(results, 'positive');
}

async function runNegativesOnly() {
  printSummary._startedAt = new Date().toISOString();
  const results = await runNamedList(listNegativeScenarioNames(), 'NEGATIVE scenarios');
  printSummary(results, 'negative');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    printScenarioList();
    return;
  }

  if (args.all) {
    await runAll();
    return;
  }

  if (args.positive) {
    await runPositivesOnly();
    return;
  }

  if (args.negative) {
    await runNegativesOnly();
    return;
  }

  const scenarioName = args.scenario || process.env.SCENARIO || DEFAULT_SCENARIO;
  const result = await runOne(scenarioName);
  if (!result.ok) {
    console.error('Fatal:', result.error || 'scenario failed');
    process.exitCode = 1;
  }
})().catch(async (err) => {
  stopLocalAuthServer();
  await cleanupBrowser().catch(() => stopChromeProcess());
  console.error('Fatal:', err.message);
  process.exitCode = 1;
});
