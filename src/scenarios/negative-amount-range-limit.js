const { AMOUNT_RANGE_LIMIT, PILOT_STORE, CARD_SEARCH } = require('../testdata/receiptLookup');

/**
 * Negative scenario: amount max−min must be between $1 and $5.
 * Entering a larger span must show an error/warning on the form.
 */
module.exports = {
  name: 'negative-amount-range-limit',
  description:
    'NEGATIVE — enter amount span > $5 and assert validation error/warning message',
  expectNegative: 'amountRange',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: PILOT_STORE, // not used — validation only
    startDate: CARD_SEARCH.startDate,
    endDate: CARD_SEARCH.endDate,
    amountFrom: AMOUNT_RANGE_LIMIT.amountFrom,
    amountTo: AMOUNT_RANGE_LIMIT.amountTo,
    identifyBy: 'card',
    cardLastThree: '789',
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: false,
};
