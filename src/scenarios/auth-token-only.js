/** Scenario: Capture token from localhost:7575 and apply to extension only */
module.exports = {
  name: 'auth-token-only',
  description: 'Local auth + extension/token apply only (no Receipt Lookup, no Sumo)',
  runLocalAuth: true,
  runExtensionPaste: true,
  runReceiptLookup: false,
  runSumoCheck: false,
};
