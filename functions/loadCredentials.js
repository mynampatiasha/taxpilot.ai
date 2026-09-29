// Shared credential loading — used by both sync.js (CLI/local) and
// server.js (hosted). Reads from environment variables first (how a host
// like Render supplies secrets), falling back to local files for local dev.
// Never put real values in this repo — see functions/.gitignore.
const path = require('path');
const fs = require('fs');

function loadCredentials() {
  const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');
  let serviceAccount;
  if (process.env.SERVICE_ACCOUNT_KEY_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
    } catch (e) {
      throw new Error('SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON: ' + e.message);
    }
  } else if (fs.existsSync(KEY_PATH)) {
    serviceAccount = require(KEY_PATH);
  } else {
    throw new Error('No credentials found — set SERVICE_ACCOUNT_KEY_JSON (hosted) or add serviceAccountKey.json (local).');
  }
  if (!process.env.SOURCE_MONGO_URI) {
    throw new Error('Missing SOURCE_MONGO_URI — set it as an environment variable (hosted) or in .env (local).');
  }
  return { serviceAccount, mongoUri: process.env.SOURCE_MONGO_URI };
}

module.exports = { loadCredentials };
