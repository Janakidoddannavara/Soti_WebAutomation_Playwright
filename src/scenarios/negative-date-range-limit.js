const { DATE_RANGE_LIMIT, PILOT_STORE } = require('../testdata/receiptLookup');

/**
 * Negative scenario: End-date calendar only allows a 5-day inclusive window.
 * After picking Start, days outside Start→Start+4 are disabled.
 */
module.exports = {
  name: 'negative-date-range-limit',
  description:
    'NEGATIVE — pick Start date then assert End calendar disables days outside the 5-day window',
  expectNegative: 'dateRange',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: PILOT_STORE, // not used — validation only
    startDate: DATE_RANGE_LIMIT.startDate,
    endDate: DATE_RANGE_LIMIT.startDate,
    amountFrom: '1.00',
    amountTo: '2.00',
    identifyBy: 'card',
    cardLastThree: '789',
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: false,
};
