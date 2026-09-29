// ============================================================================
// TAXPILOT SYNC SERVER — the hosted (Render) version. Stays running and
// exposes one protected endpoint, GET/POST /sync, that runs the same sync
// as sync.js. A free external scheduler (e.g. cron-job.org) hits this URL
// every ~10-14 minutes — that single request both keeps this free Render
// service awake (free services sleep after 15 min idle) and triggers the
// sync, so no paid Render plan is needed.
//
// Environment variables required (set in Render's dashboard, never in this
// repo): SOURCE_MONGO_URI, SERVICE_ACCOUNT_KEY_JSON, TAXPILOT_API_KEY
// (choose your own value for this last one — it's the key the external
// scheduler must send back as ?key=... or an x-api-key header).
// ============================================================================

const http = require('http');
const admin = require('firebase-admin');
const { loadCredentials } = require('./loadCredentials');
const { runSync } = require('./syncCore');

let creds;
try {
  creds = loadCredentials();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!process.env.TAXPILOT_API_KEY) {
  console.error('Missing TAXPILOT_API_KEY — set it in Render\'s environment variables (any value you choose).');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(creds.serviceAccount) });
const db = admin.firestore();

let syncInProgress = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('TaxPilot sync server is running.');
  }

  if (url.pathname === '/sync') {
    const key = req.headers['x-api-key'] || url.searchParams.get('key');
    if (key !== process.env.TAXPILOT_API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing or invalid API key.' }));
    }
    if (syncInProgress) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A sync is already running — try again shortly.' }));
    }
    syncInProgress = true;
    try {
      const result = await runSync(db, creds.mongoUri);
      console.log(result.log.join('\n'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, synced: result.synced, mappings: result.mappings }));
    } catch (e) {
      console.error('Sync failed:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    } finally {
      syncInProgress = false;
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use GET/POST /sync with x-api-key.' }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`TaxPilot sync server listening on port ${port}`));
