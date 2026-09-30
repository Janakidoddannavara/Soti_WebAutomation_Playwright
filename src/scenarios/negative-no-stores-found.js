const { NO_STORES_SEARCH, UNKNOWN_STORE } = require('../testdata/receiptLookup');

/**
 * Negative scenario: store API returns no stores for 1907 (not in pilot dropdown).
 * Expect dropdown message: "No stores found"
 */
module.exports = {
  name: 'negative-no-stores-found',
  description: `NEGATIVE — type store ${UNKNOWN_STORE} and assert "No stores found" (1907 only used here)`,
  expectNegative: 'noStores',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: NO_STORES_SEARCH.storeNameOrNumber, // 1907
    startDate: NO_STORES_SEARCH.startDate,
    endDate: NO_STORES_SEARCH.endDate,
    amountFrom: NO_STORES_SEARCH.amountFrom,
    amountTo: NO_STORES_SEARCH.amountTo,
    identifyBy: 'card',
    cardLastThree: NO_STORES_SEARCH.cardLastThree,
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: false,
};
