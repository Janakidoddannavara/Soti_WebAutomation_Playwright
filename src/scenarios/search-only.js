const { CARD_SEARCH } = require('../testdata/receiptLookup');

/** Scenario: Receipt Lookup search + Sumo verify (no keep-open extras) */
module.exports = {
  name: 'search-only',
  description:
    'Auth + token + Receipt Lookup card search (store 1002), then Sumo Found N / criteria check',
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
  runSumoCheck: true, // always verify Sumo after search
};
