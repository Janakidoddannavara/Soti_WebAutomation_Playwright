const byDetailsCard = require('./byDetails-card');
const byDetailsFlybuys = require('./byDetails-flybuys');
const byDetailsOnepass = require('./byDetails-onepass');
const byDigitalReceiptNumber = require('./byDigitalReceiptNumber');
const searchOnly = require('./search-only');
const authTokenOnly = require('./auth-token-only');
const browserInject = require('./browser-inject');
const browserOsChrome = require('./browser-os-chrome');
const sumoOnly = require('./sumo-only');
const negativeNoStoresFound = require('./negative-no-stores-found');
const negativeNoReceiptsDigital = require('./negative-no-receipts-digital');
const negativeDateRangeLimit = require('./negative-date-range-limit');
const negativeAmountRangeLimit = require('./negative-amount-range-limit');

/**
 * Positive scenarios — identify-by trio first (each opens receipt then Sumo):
 *   1) card  2) flybuys  3) onepass
 * then other positive flows.
 */
const POSITIVE_SCENARIOS = {
  [byDetailsCard.name]: byDetailsCard,
  [byDetailsFlybuys.name]: byDetailsFlybuys,
  [byDetailsOnepass.name]: byDetailsOnepass,
  [byDigitalReceiptNumber.name]: byDigitalReceiptNumber,
  [searchOnly.name]: searchOnly,
  [authTokenOnly.name]: authTokenOnly,
  [browserInject.name]: browserInject,
  [browserOsChrome.name]: browserOsChrome,
  [sumoOnly.name]: sumoOnly,
};

/**
 * Negative scenarios — assert exact UI error / validation messages:
 *   store 1907 → "No stores found"
 *   bad digital RN → "No Receipts Found"
 *   date / amount range limits
 */
const NEGATIVE_SCENARIOS = {
  [negativeNoStoresFound.name]: negativeNoStoresFound,
  [negativeNoReceiptsDigital.name]: negativeNoReceiptsDigital,
  [negativeDateRangeLimit.name]: negativeDateRangeLimit,
  [negativeAmountRangeLimit.name]: negativeAmountRangeLimit,
};

/** All named scenarios — positives first, then negatives. */
const SCENARIOS = {
  ...POSITIVE_SCENARIOS,
  ...NEGATIVE_SCENARIOS,
};

const DEFAULT_SCENARIO = byDetailsCard.name;

function isNegativeScenario(scenarioOrName) {
  const name =
    typeof scenarioOrName === 'string'
      ? scenarioOrName
      : scenarioOrName?.name || '';
  return Boolean(NEGATIVE_SCENARIOS[name]) || Boolean(scenarioOrName?.expectNegative);
}

function listScenarios() {
  return Object.values(SCENARIOS).map((s) => ({
    name: s.name,
    description: s.description || '',
    negative: isNegativeScenario(s),
  }));
}

function listPositiveScenarioNames() {
  return Object.keys(POSITIVE_SCENARIOS);
}

function listNegativeScenarioNames() {
  return Object.keys(NEGATIVE_SCENARIOS);
}

function getScenario(name) {
  const key = String(name || '').trim();
  if (!key) return SCENARIOS[DEFAULT_SCENARIO];
  const scenario = SCENARIOS[key];
  if (!scenario) {
    const available = Object.keys(SCENARIOS).join(', ');
    throw new Error(`Unknown scenario "${key}". Available: ${available}`);
  }
  return scenario;
}

module.exports = {
  SCENARIOS,
  POSITIVE_SCENARIOS,
  NEGATIVE_SCENARIOS,
  DEFAULT_SCENARIO,
  listScenarios,
  listPositiveScenarioNames,
  listNegativeScenarioNames,
  isNegativeScenario,
  getScenario,
};
