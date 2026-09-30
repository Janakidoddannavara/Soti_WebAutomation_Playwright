const { CONFIG } = require('./config');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Snapshot of defaults from config.js — used to reset between scenarios. */
const BASE_CONFIG = deepClone(CONFIG);

function resetConfig() {
  for (const key of Object.keys(CONFIG)) {
    delete CONFIG[key];
  }
  Object.assign(CONFIG, deepClone(BASE_CONFIG));
  return CONFIG;
}

/** Reset CONFIG to defaults, then deep-merge scenario fields. */
function applyScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('Scenario must be an object');
  }

  resetConfig();

  for (const [key, value] of Object.entries(scenario)) {
    if (key === 'name' || key === 'description') continue;
    if (isPlainObject(value) && isPlainObject(CONFIG[key])) {
      CONFIG[key] = { ...CONFIG[key], ...value };
    } else {
      CONFIG[key] = value;
    }
  }

  CONFIG.activeScenario = scenario.name || 'custom';
  return CONFIG;
}

function validateScenarioConfig(config = CONFIG) {
  const errors = [];

  // Negative scenarios have their own required fields
  if (config.expectNegative === 'noReceipts') {
    if (config.searchMode === 'byDigitalReceiptNumber') {
      const n = String(config.digitalReceiptNumber || '').trim();
      if (!/^\d{22}$/.test(n)) {
        errors.push('digitalReceiptNumber must be exactly 22 digits (negative noReceipts)');
      }
      return errors;
    }
    // byDetails path (e.g. flybuys/onepass with no hits)
    const d = config.byDetails || {};
    if (!d.storeNameOrNumber) errors.push('byDetails.storeNameOrNumber is required (noReceipts)');
    if (!d.startDate || !d.endDate) errors.push('byDetails dates required (noReceipts)');
    return errors;
  }
  if (config.expectNegative === 'noStores') {
    if (!config.byDetails?.storeNameOrNumber) {
      errors.push('byDetails.storeNameOrNumber is required (negative noStores)');
    }
    return errors;
  }
  if (config.expectNegative === 'dateRange') {
    if (!config.byDetails?.startDate) {
      errors.push('byDetails.startDate is required (negative dateRange)');
    }
    return errors;
  }
  if (config.expectNegative === 'amountRange') {
    const d = config.byDetails || {};
    if (d.amountFrom == null || d.amountTo == null) {
      errors.push('byDetails.amountFrom and amountTo are required (negative amountRange)');
    }
    return errors;
  }

  if (config.searchMode === 'byDigitalReceiptNumber') {
    const n = String(config.digitalReceiptNumber || '').trim();
    if (!/^\d{22}$/.test(n)) {
      errors.push('digitalReceiptNumber must be exactly 22 digits');
    }
  } else if (config.searchMode === 'byDetails') {
    const d = config.byDetails || {};
    if (!d.storeNameOrNumber) errors.push('byDetails.storeNameOrNumber is required');
    if (!d.startDate || !d.endDate) errors.push('byDetails.startDate and endDate are required');
    if (d.amountFrom == null || d.amountTo == null) {
      errors.push('byDetails.amountFrom and amountTo are required');
    }

    const identifyBy = (d.identifyBy || 'card').toLowerCase();
    if (identifyBy === 'card') {
      if (!/^\d{3}$/.test(String(d.cardLastThree || ''))) {
        errors.push('byDetails.cardLastThree must be exactly 3 digits');
      }
    } else if (identifyBy === 'flybuys') {
      if (!/^\d{13}$/.test(String(d.flybuysId || ''))) {
        errors.push('byDetails.flybuysId must be exactly 13 digits');
      }
    } else if (identifyBy === 'onepass') {
      if (!/^\d{13}$/.test(String(d.onepassId || ''))) {
        errors.push('byDetails.onepassId must be exactly 13 digits');
      }
    } else {
      errors.push(`Unknown identifyBy: ${identifyBy}`);
    }
  } else {
    errors.push(`Unknown searchMode: ${config.searchMode}`);
  }

  return errors;
}

module.exports = { applyScenario, validateScenarioConfig, resetConfig };
