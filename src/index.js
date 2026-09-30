/** Framework public API — Receipt Lookup + Sumo Logic only. */
module.exports = {
  CONFIG: require('./config/config').CONFIG,
  ...require('./config/applyScenario'),
  ...require('./testdata/receiptLookup'),
  ...require('./scenarios'),
  ...require('./utils/helpers'),
  ...require('./core/browser'),
  ...require('./auth/tokenCapture'),
  ...require('./auth/localAuth'),
  ...require('./auth/tokenApply'),
  ...require('./pages/receiptLookup'),
  ...require('./pages/sumo'),
  ...require('./flows/receiptLookupFlow'),
  ...require('./assertions/expectedMessages'),
  ...require('./reporting/reporter'),
  architecture: require('./framework/architecture'),
};
