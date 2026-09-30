/**
 * Framework layer map — how layers connect.
 *
 *   runners/          CLI (list / one / positive / negative / all)
 *        ↓
 *   scenarios/        Named test cases (data + toggles only)
 *        ↓
 *   flows/            Orchestration: auth → token → search → Sumo → close
 *        ↓
 *   pages/            Page Object actions (Receipt Lookup UI, Sumo UI)
 *   auth/             localhost:7575 token + extension / inject
 *   core/             Browser launch / CDP / cleanup
 *   assertions/       Expected error strings for negatives
 *   testdata/         Stores, dates, card / Flybuys / OnePass / digital RN
 *   reporting/        Suite JSON + markdown under output/reports/
 *   config/           CONFIG + .env + scenario apply/validate
 */

module.exports = {
  layers: [
    'runners',
    'scenarios',
    'flows',
    'pages',
    'auth',
    'core',
    'assertions',
    'testdata',
    'reporting',
    'config',
  ],
};
