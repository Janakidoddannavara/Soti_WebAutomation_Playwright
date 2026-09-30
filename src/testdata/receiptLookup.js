/**
 * Receipt Lookup PDT test data.
 *
 * Positive searches use pilot store 1002 (appears in store dropdown).
 * Store 1907 is reserved for the negative "No stores found" scenario only.
 */

/** Pilot store that appears in the Receipt Lookup dropdown. */
const PILOT_STORE = '1002';

/** Non-pilot store — use only for negative-no-stores-found. */
const UNKNOWN_STORE = '1907';

/**
 * Known store-1002 receipt (from prior successful PDT run):
 *   Kmart Blacktown - 14/07/26
 *   1002202607141130818662
 *   $42.00
 */
const RECEIPTS_1002 = [
  {
    id: 1,
    receiptNumber: '1002202607141130818662',
    store: PILOT_STORE,
    issuedAt: '2026-07-14',
    issuedDate: '14/07/2026',
    total: '42.00',
    cardLastThree: '789',
  },
];

/** Legacy store-1907 samples — kept for negative digital / documentation only. */
const RECEIPTS_1907 = [
  {
    id: 1,
    receiptNumber: '1907202604201456830096',
    store: UNKNOWN_STORE,
    issuedAt: '2026-04-20 14:56:15 +10:00',
    issuedDate: '20/04/2026',
    total: '11.47',
    payment: 'VISA Credit',
    cardLastThree: '446',
    flybuysId: '2791990001112',
    onepassId: '2778100000012',
  },
];

const RECEIPTS = RECEIPTS_1002;

/** Primary card search — store 1002, card …789, $40–$45 over 12–16 Jul 2026. */
const CARD_SEARCH = {
  storeNameOrNumber: PILOT_STORE,
  startDate: '12/07/2026',
  endDate: '16/07/2026',
  amountFrom: '40.00',
  amountTo: '45.00',
  identifyBy: 'card',
  cardLastThree: '789',
  flybuysId: '',
  onepassId: '',
  expectedReceiptNumber: '1002202607141130818662',
};

/**
 * Flybuys search — pilot store 1002, same 5-day / $5 amount window as card.
 * Sumo must show flybuysId after search. Update ID if your 1002 test receipt differs.
 */
const FLYBUYS_SEARCH = {
  storeNameOrNumber: PILOT_STORE,
  startDate: '12/07/2026',
  endDate: '16/07/2026',
  amountFrom: '40.00',
  amountTo: '45.00',
  identifyBy: 'flybuys',
  cardLastThree: '',
  flybuysId: '2791990001112',
  onepassId: '',
};

/**
 * OnePass search — pilot store 1002, same 5-day / $5 amount window as card.
 * Sumo must show onepassId after search. Update ID if your 1002 test receipt differs.
 */
const ONEPASS_SEARCH = {
  storeNameOrNumber: PILOT_STORE,
  startDate: '12/07/2026',
  endDate: '16/07/2026',
  amountFrom: '40.00',
  amountTo: '45.00',
  identifyBy: 'onepass',
  cardLastThree: '',
  flybuysId: '',
  onepassId: '2778100000012',
};

/** Digital receipt number — store 1002 receipt (positive search). */
const DIGITAL_RECEIPT = {
  digitalReceiptNumber: '1002202607141130818662',
  expectedStore: PILOT_STORE,
  expectedAmount: '42.00',
};

/**
 * Negative — digital RN that returns no receipts (1907 RN, not in PDT for this token).
 */
const DIGITAL_RECEIPT_NEGATIVE = {
  digitalReceiptNumber: '1907202604201456830096',
};

/**
 * Negative — date window: UI allows only a 5-day inclusive range (start → start+4).
 * Days outside that window on the End calendar are disabled.
 */
const DATE_RANGE_LIMIT = {
  startDate: '12/07/2026',
};

/**
 * Negative — amount window: UI accepts only a $1–$5 difference (max − min).
 * Values below use a $10 span so the form shows an error/warning.
 */
const AMOUNT_RANGE_LIMIT = {
  amountFrom: '10.00',
  amountTo: '20.00',
};

/** Negative — store not in pilot dropdown. */
const NO_STORES_SEARCH = {
  storeNameOrNumber: UNKNOWN_STORE,
  startDate: CARD_SEARCH.startDate,
  endDate: CARD_SEARCH.endDate,
  amountFrom: CARD_SEARCH.amountFrom,
  amountTo: CARD_SEARCH.amountTo,
  identifyBy: 'card',
  cardLastThree: CARD_SEARCH.cardLastThree,
};

module.exports = {
  PILOT_STORE,
  UNKNOWN_STORE,
  RECEIPTS,
  RECEIPTS_1002,
  RECEIPTS_1907,
  CARD_SEARCH,
  FLYBUYS_SEARCH,
  ONEPASS_SEARCH,
  DIGITAL_RECEIPT,
  DIGITAL_RECEIPT_NEGATIVE,
  DATE_RANGE_LIMIT,
  AMOUNT_RANGE_LIMIT,
  NO_STORES_SEARCH,
};
