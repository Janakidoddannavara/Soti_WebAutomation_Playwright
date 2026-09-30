# Receipt Lookup — Playwright Framework

Automated **Receipt Lookup** UI tests with **Sumo Logic** log cross-verification.

## Architecture

```
runners/receiptLookup.js     CLI entry (list / one / positive / negative / all)
        │
        ▼
src/scenarios/               Named scenarios (data + step toggles only)
        │
        ▼
src/flows/                   Auth → token → search → open receipt → Sumo → close
        │
   ┌────┴────┬──────────┬────────────┐
   ▼         ▼          ▼            ▼
pages/     auth/      core/      assertions/
(POM)    (7575+inject) (Chrome)  (expected msgs)
   │
testdata/  config/  reporting/ → output/reports/
```

| Layer | Responsibility |
|-------|----------------|
| **runners** | CLI flags, batch order (positives → negatives), exit codes |
| **scenarios** | One file per test case — search criteria + `runSumoCheck` / `expectNegative` |
| **flows** | End-to-end orchestration |
| **pages** | Page Object actions for Receipt Lookup + Sumo |
| **auth** | MSAL token from `localhost:7575`, extension paste / WS inject |
| **core** | Chrome CDP / inject / os-chrome launch + cleanup |
| **assertions** | Shared expected error strings for negatives |
| **testdata** | Store 1002 (pilot), store 1907 (negative only), card / Flybuys / OnePass / digital |
| **reporting** | Suite JSON + markdown under `output/reports/` |
| **config** | `CONFIG`, `.env`, scenario merge + validation |

## Positive flow (identify-by)

1. **Card** last 3 → open receipt → Sumo Found N + `cardLastThree`
2. **Flybuys** ID → open receipt → Sumo Found N + `flybuysId`
3. **OnePass** ID → open receipt → Sumo Found N + `onepassId`
4. Then digital / auth / browser variants

## Negative flow (error messages)

| Scenario | Expected UI |
|----------|-------------|
| `negative-no-stores-found` | Store **1907** → `"No stores found"` |
| `negative-no-receipts-digital` | `"No Receipts Found"` + refine-search detail |
| `negative-date-range-limit` | Days outside 5-day window **disabled** |
| `negative-amount-range-limit` | `"Range is $X — limit is $5.00. Search will fail."` |

## Run

```bash
npm install
# set SUMO_PASSWORD (and optional SUMO_EMAIL) in .env

npm run scenarios              # list
npm run scenarios:identify     # card → flybuys → onepass (+ Sumo each)
npm run scenarios:positive
npm run scenarios:negative
npm run scenarios:all          # positives then negatives + report

npm run scenario:card
npm run scenario:flybuys
npm run scenario:onepass
npm run scenario:neg-no-stores
```

Entry points:
- `npm start` / `npm run receipt-logs` → `runners/receiptLookup.js`
- `node Receipt_Lookup_Sumo_Logs.js` → same runner (thin wrapper)

## Config & data

- Defaults: `src/config/config.js`
- Scenario overrides: `src/scenarios/*.js`
- Search data: `src/testdata/receiptLookup.js` (pilot store **1002**; **1907** only for no-stores negative)
- Expected messages: `src/assertions/expectedMessages.js`

## Reports

After a batch run:

- `output/reports/latest.md`
- `output/reports/latest.json`
