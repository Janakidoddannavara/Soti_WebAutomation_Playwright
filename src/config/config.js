require('./env');
const path = require('path');

const CONFIG = {
  receiptLookupUrl: 'https://ui-pdt-receipt-lookup.prod.dsf-cs-prod.a-kmtkmg.net/',

  // Search mode:
  //   'byDetails'               → Store + dates + amount + Card/Flybuys/OnePass
  //   'byDigitalReceiptNumber'  → Digital Receipt Number only (22 digits)
  searchMode: 'byDetails',

  // Used when searchMode = 'byDetails'
  // Default PDT test data: pilot store 1002 (dropdown), card …789
  byDetails: {
    storeNameOrNumber: '1002',
    startDate: '12/07/2026',
    endDate: '16/07/2026',
    amountFrom: '40.00',
    amountTo: '45.00',
    // Identify by: 'card' | 'flybuys' | 'onepass'
    identifyBy: 'card',
    cardLastThree: '789',
    flybuysId: '2791990001112',
    onepassId: '2778100000012',
  },

  // Used when searchMode = 'byDigitalReceiptNumber'
  digitalReceiptNumber: '1002202607141130818662',

  // Extra seconds after a receipt is open (Sumo ingest). Results wait on UI, not this.
  waitAfterSearchSeconds: 2,
  // Keep opened receipt visible this many seconds before clicking New Search
  receiptViewSeconds: 10,

  // Local PDT auth site — Sign in here first; token is captured from Network (same as Inspect → Network → token)
  // Token rotates about every 1 hour — script ALWAYS fetches a fresh token on each run (never reused from disk).
  localAuthUrl: 'http://localhost:7575/',
  localAuthAccount: 'janaki.doddannavara@anko.com',
  // Auto-start the MSAL sample server if 7575 is down (you normally just open the page in Chrome)
  localAuthServerDir: path.join(
    process.env.HOME || '',
    'Documents/ms-identity-javascript-v2-master'
  ),
  autoStartLocalAuthServer: true,
  // Refresh again if token will expire within this many minutes
  tokenRefreshSkewMinutes: 5,

  // Browser strategy:
  //   'os-chrome'   — reuse YOUR Chrome profile (Sumo already logged in). Quit Chrome first.
  //   'chrome-cdp'  — isolated profile + load extension (Kmart SSO fails with AADSTS50105)
  //   'inject'      — skip extension UI; inject token the same way the extension Config message does
  browserMode: 'chrome-cdp',
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromeDebugPort: 9222,
  osChromeUserDataDir: path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome'),
  osChromeProfileDirectory: 'Default',

  // Kmart Device Emulator Chrome extension — paste Auth Token here, then reload Receipt Lookup
  extensionPath: path.join(
    process.env.HOME || '',
    'Documents/GitHub/kmart-device-emulator-chrome-extension/extension'
  ),
  // Installed extension id from chrome://extensions (used when connecting to your normal Chrome)
  extensionId: 'jagfjolngdgfmjfcaamnpmpfbpbkfkea',
  // Device store id in the extension popup (separate from Receipt Lookup search store)
  extensionStoreId: '1907',
  // Store server shown in your extension popup
  extensionStoreServer: 'https://kv1907na001.core.kmtltd.net.au',

  // Step toggles
  runLocalAuth: true, // launch localhost:7575 and fetch Network token
  runExtensionPaste: true, // paste token into Kmart Device Emulator Auth Token field
  runReceiptLookup: true, // open Receipt Lookup and run search scenario

  // Set true after receipt search to open Sumo and run the error query.
  // Positive search scenarios (card / flybuys / onepass / digital) should keep this true
  // so Sumo verifies the same identify-by criteria after UI search.
  runSumoCheck: true,

  // Sumo Logic — https://kmartgroup.au.sumologic.com/ui/#/search/29f3ef3f_768f_b52c_4b03_14bf0b793d3e
  sumoSearchUrl:
    'https://kmartgroup.au.sumologic.com/ui/#/search/29f3ef3f_768f_b52c_4b03_14bf0b793d3e',
  // Prefer .env (SUMO_EMAIL / SUMO_PASSWORD) so credentials are not committed
  sumoEmail: process.env.SUMO_EMAIL || 'janaki.doddannavara@anko.com',
  sumoPassword: process.env.SUMO_PASSWORD || '',
  // User's Sumo query (do not re-paste if already in the search box)
  // Exclude HttpRequestLogger noise; ReceiptService holds "Found N receipt(s)" for UI compare.
  sumoQuery: `(_collector="dsf-cs-receiptlookup") and (_sourceCategory="dsfcs/prod/aws/ecs/api") | where Context != "HttpRequestLogger" | where Context = "ReceiptService"`,


  // Environment: prod | uat | dev
  env: 'prod',
  // Service layer: 'api' | 'bff' | 'api/bff'
  serviceLayer: 'api',

  outputDir: path.join(process.cwd(), 'output'),
  headless: false,
  // Keep browser open after run so you can review results
  keepOpenSeconds: 20,
  // How long to wait for localhost:7575 to become available (ms)
  localAuthWaitMs: 180000,
};

module.exports = { CONFIG };
