const { DIGITAL_RECEIPT } = require('../testdata/receiptLookup');

/** Scenario: By digital receipt number + Sumo compare */
module.exports = {
  name: 'byDigitalReceiptNumber',
  description:
    'Search by digital receipt 1002202607141130818662 (store 1002, $42.00), then compare Sumo Found N',
  searchMode: 'byDigitalReceiptNumber',
  digitalReceiptNumber: DIGITAL_RECEIPT.digitalReceiptNumber,
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: true,
};
