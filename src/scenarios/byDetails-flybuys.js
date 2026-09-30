const { FLYBUYS_SEARCH } = require('../testdata/receiptLookup');

/** Scenario 2: By details + Flybuys ID → open receipt → Sumo cross-verify */
module.exports = {
  name: 'byDetails-flybuys',
  description:
    'Search pilot store 1002 by Flybuys ID, open receipt, then cross-verify Sumo Found N + flybuysId',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: FLYBUYS_SEARCH.storeNameOrNumber,
    startDate: FLYBUYS_SEARCH.startDate,
    endDate: FLYBUYS_SEARCH.endDate,
    amountFrom: FLYBUYS_SEARCH.amountFrom,
    amountTo: FLYBUYS_SEARCH.amountTo,
    identifyBy: 'flybuys',
    cardLastThree: '',
    flybuysId: FLYBUYS_SEARCH.flybuysId,
    onepassId: '',
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: true,
};
