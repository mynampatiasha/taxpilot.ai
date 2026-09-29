// ============================================================================
// TAXPILOT SYNC — command-line entry point. The actual logic lives in
// syncCore.js, shared with server.js (the version that runs continuously
// on a host like Render and syncs on each HTTP ping instead of once per
// command). This file is for running the sync yourself, once, locally:
//
// LOCAL ONE-TIME SETUP:
//   1. Firebase Console -> gear icon -> Project settings -> Service accounts
//      -> "Generate new private key" -> save the downloaded JSON file as
//      serviceAccountKey.json in this same functions/ folder.
//   2. Copy .env.example to .env in this folder and fill in SOURCE_MONGO_URI
//      (from Billing_backend/.env's MONGODB_URI).
//   3. Create the orgMappings document in Firestore as before (unchanged).
//
// TO RUN LOCALLY:
//   node sync.js
// ============================================================================

require('dotenv').config();
const admin = require('firebase-admin');
const { loadCredentials } = require('./loadCredentials');
const { runSync } = require('./syncCore');

(async () => {
  let creds;
  try {
    creds = loadCredentials();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(creds.serviceAccount) });
  const db = admin.firestore();

  try {
    const result = await runSync(db, creds.mongoUri);
    result.log.forEach(line => console.log('  ' + line));
  } catch (e) {
    console.error('Sync failed:', e);
    process.exit(1);
  }
})();
