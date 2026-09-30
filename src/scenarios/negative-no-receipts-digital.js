const { DIGITAL_RECEIPT_NEGATIVE } = require('../testdata/receiptLookup');

/**
 * Negative scenario: digital receipt search finds nothing.
 * Expect orange popup:
 *   "No Receipts Found"
 *   "Try checking your details or refining your search."
 */
module.exports = {
  name: 'negative-no-receipts-digital',
  description:
    'NEGATIVE — search digital RN (1907 sample) and assert "No Receipts Found" popup',
  expectNegative: 'noReceipts',
  searchMode: 'byDigitalReceiptNumber',
  digitalReceiptNumber: DIGITAL_RECEIPT_NEGATIVE.digitalReceiptNumber,
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: true,
  runSumoCheck: false,
};
