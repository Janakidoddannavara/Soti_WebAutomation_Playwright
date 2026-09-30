const { CARD_SEARCH } = require('../testdata/receiptLookup');

/** Scenario: Full E2E reusing your real Chrome profile (Sumo cookies) */
module.exports = {
  name: 'browser-os-chrome',
  description:
    'Full flow with browserMode=os-chrome (batch uses chrome-cdp) — store 1002 card 789 + Sumo',
  browserMode: 'os-chrome',
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
  runReceiptLookup: true,
  runSumoCheck: true,
};
