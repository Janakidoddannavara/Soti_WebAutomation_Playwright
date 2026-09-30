const { CARD_SEARCH } = require('../testdata/receiptLookup');

/** Scenario: Sumo Logic check only (assumes browser already has session; skips search) */
module.exports = {
  name: 'sumo-only',
  description: 'Open Sumo and run ReceiptService query only (criteria soft-match store 1002 card data)',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: CARD_SEARCH.storeNameOrNumber,
    startDate: CARD_SEARCH.startDate,
    endDate: CARD_SEARCH.endDate,
    amountFrom: CARD_SEARCH.amountFrom,
    amountTo: CARD_SEARCH.amountTo,
    identifyBy: 'card',
    cardLastThree: CARD_SEARCH.cardLastThree,
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: false,
  runSumoCheck: true,
  // Batch overrides os-chrome → chrome-cdp; standalone can still use os-chrome.
  browserMode: 'chrome-cdp',
};
