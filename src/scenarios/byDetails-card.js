const { CARD_SEARCH } = require('../testdata/receiptLookup');

/** Scenario 1: By details + Card last 3 → open receipt → Sumo cross-verify */
module.exports = {
  name: 'byDetails-card',
  description:
    'Search pilot store 1002 by card last 3 (789), open receipt, then cross-verify Sumo Found N + cardLastThree',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: CARD_SEARCH.storeNameOrNumber,
    startDate: CARD_SEARCH.startDate,
    endDate: CARD_SEARCH.endDate,
    amountFrom: CARD_SEARCH.amountFrom,
    amountTo: CARD_SEARCH.amountTo,
    identifyBy: 'card',
    cardLastThree: CARD_SEARCH.cardLastThree,
    flybuysId: '',
    onepassId: '',
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: true,
};
