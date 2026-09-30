const { CARD_SEARCH } = require('../testdata/receiptLookup');

/** Scenario: Full E2E using WebSocket Config inject (no extension UI) */
module.exports = {
  name: 'browser-inject',
  description: 'Full flow with browserMode=inject — store 1002 card 789 + Sumo',
  browserMode: 'inject',
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
