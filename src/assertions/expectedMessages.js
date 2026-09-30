/**
 * Expected UI messages for Receipt Lookup negative checks.
 * Keep page assertions in sync with these constants.
 */
const EXPECTED_MESSAGES = {
  noStoresFound: {
    text: 'No stores found',
    pattern: /No stores found/i,
  },
  noReceiptsFound: {
    title: 'No Receipts Found',
    detail: 'Try checking your details or refining your search.',
    titlePattern: /No Receipts Found/i,
    detailPattern: /Try checking your details or refining your search/i,
  },
  amountRangeLimit: {
    /** e.g. "Range is $10.00 — limit is $5.00. Search will fail." */
    pattern: /Range is \$[\d.]+.*limit is \$5\.00.*Search will fail/i,
    limitDollars: 5,
  },
  dateRangeLimitDays: 5, // inclusive: start → start+4 enabled; start+5 disabled
};

module.exports = { EXPECTED_MESSAGES };
