// Shared credential loading — used by both sync.js (CLI/local) and
// server.js (hosted). Reads from environment variables first (how a host
// like Render supplies secrets), falling back to local files for local dev.
// Never put real values in this repo — see functions/.gitignore.
const path = require('path');
const fs = require('fs');

// Required to start at all — this is TaxPilot's own credential (Firestore
// write access), not Abra Finance's.
function loadServiceAccount() {
  const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');
  if (process.env.SERVICE_ACCOUNT_KEY_JSON) {
    try {
      return JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    } catch (e) {
      throw new Error('SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON: ' + e.message);
    }
  }
  if (fs.existsSync(KEY_PATH)) return require(KEY_PATH);
  throw new Error('No credentials found — set SERVICE_ACCOUNT_KEY_JSON (hosted) or add serviceAccountKey.json (local).');
}

// Separate from the service account on purpose: this is the one credential
// that reads Abra Finance's own database, so it's kept as its own check —
// callers decide what to do when it's missing (server.js can still start
// and answer health checks without it; the CLI script requires it upfront).
function getMongoUri() {
  return process.env.SOURCE_MONGO_URI || null;
}

module.exports = { loadServiceAccount, getMongoUri };
