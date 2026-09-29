// ============================================================================
// TAXPILOT SYNC SERVER — the hosted (Render) version. Stays running and
// exposes one protected endpoint, GET/POST /sync, that runs the same sync
// as sync.js. A free external scheduler (e.g. cron-job.org) hits this URL
// every ~10-14 minutes — that single request both keeps this free Render
// service awake (free services sleep after 15 min idle) and triggers the
// sync, so no paid Render plan is needed.
//
// Environment variables:
//   SERVICE_ACCOUNT_KEY_JSON, TAXPILOT_API_KEY — required to start at all.
//   SOURCE_MONGO_URI — NOT required to start. The server comes up and
//     answers health checks without it; only /sync needs it, and returns a
//     clear error until it's set. This is deliberate: SOURCE_MONGO_URI
//     must be a dedicated READ-ONLY MongoDB user scoped to Abra Finance's
//     invoices/creditnotes/bills collections — never Abra's own full-access
//     production credential — so the server can go live first and that
//     user gets added once it exists, rather than blocking on it.
// ============================================================================

const http = require('http');
const admin = require('firebase-admin');
const { loadServiceAccount, getMongoUri } = require('./loadCredentials');
const { runSync } = require('./syncCore');

let serviceAccount;
try {
  serviceAccount = loadServiceAccount();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!process.env.TAXPILOT_API_KEY) {
  console.error('Missing TAXPILOT_API_KEY — set it in Render\'s environment variables (any value you choose).');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

let syncInProgress = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') {
    const mongoUri = getMongoUri();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`TaxPilot sync server is running. Mongo source: ${mongoUri ? 'configured' : 'NOT YET CONFIGURED — /sync will return an error until SOURCE_MONGO_URI is set'}.`);
  }

  if (url.pathname === '/sync') {
    const key = req.headers['x-api-key'] || url.searchParams.get('key');
    if (key !== process.env.TAXPILOT_API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing or invalid API key.' }));
    }
    const mongoUri = getMongoUri();
    if (!mongoUri) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'SOURCE_MONGO_URI is not set yet — add it (a read-only MongoDB user, not Abra Finance\'s own credential) in Render\'s environment variables.' }));
    }
    if (syncInProgress) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A sync is already running — try again shortly.' }));
    }
    syncInProgress = true;
    try {
      const result = await runSync(db, mongoUri);
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
