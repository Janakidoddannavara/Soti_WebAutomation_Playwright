const { ONEPASS_SEARCH } = require('../testdata/receiptLookup');

/** Scenario 3: By details + OnePass ID → open receipt → Sumo cross-verify */
module.exports = {
  name: 'byDetails-onepass',
  description:
    'Search pilot store 1002 by OnePass ID, open receipt, then cross-verify Sumo Found N + onepassId',
  searchMode: 'byDetails',
  byDetails: {
    storeNameOrNumber: ONEPASS_SEARCH.storeNameOrNumber,
    startDate: ONEPASS_SEARCH.startDate,
    endDate: ONEPASS_SEARCH.endDate,
    amountFrom: ONEPASS_SEARCH.amountFrom,
    amountTo: ONEPASS_SEARCH.amountTo,
    identifyBy: 'onepass',
    cardLastThree: '',
    flybuysId: '',
    onepassId: ONEPASS_SEARCH.onepassId,
  },
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: true,
};
