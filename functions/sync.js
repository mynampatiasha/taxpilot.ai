// ============================================================================
// TAXPILOT SYNC — standalone version, no Firebase billing plan required.
//
// This replaces the Cloud Functions version of the sync (scheduledSync /
// syncNow in index.js) with a plain Node.js script, using the same
// firestore/gstEngine logic. It reads Abra's MongoDB directly (Abra
// Finance's own code is never touched) and writes results into TaxPilot's
// Firestore — no Blaze billing plan needed, whether run locally or hosted.
//
// Credentials are read two ways, so the exact same script works both on
// your own machine and on a host like Render:
//   - Locally: serviceAccountKey.json in this folder + a .env file
//     (both gitignored — never committed).
//   - Hosted (e.g. Render Cron Job): environment variables instead of
//     files — SERVICE_ACCOUNT_KEY_JSON (paste the whole key file's JSON
//     content as one env var value) and SOURCE_MONGO_URI, set in the
//     host's own dashboard, never in this repo.
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
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');
const { evaluateInvoice, STATE_CODES, fyOf } = require('./gstEngine');

const KEY_PATH = path.join(__dirname, 'serviceAccountKey.json');
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_KEY_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);
  } catch (e) {
    console.error('SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON:', e.message);
    process.exit(1);
  }
} else if (fs.existsSync(KEY_PATH)) {
  serviceAccount = require(KEY_PATH);
} else {
  console.error('No credentials found — set SERVICE_ACCOUNT_KEY_JSON (hosted) or add serviceAccountKey.json (local). See the setup steps at the top of this file.');
  process.exit(1);
}
if (!process.env.SOURCE_MONGO_URI) {
  console.error('Missing SOURCE_MONGO_URI — set it as an environment variable (hosted) or in .env (local).');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const STATE_NAME_TO_CODE = Object.fromEntries(
  Object.entries(STATE_CODES).map(([code, name]) => [name.toLowerCase(), code])
);
function stateNameToCode(name) {
  return STATE_NAME_TO_CODE[String(name || '').trim().toLowerCase()] || '';
}

/* Field mapping — identical to the Cloud Functions version, verified against
   Billing_backend/routes/invoices.js, credit-notes.js and bill.js. Same two
   known gaps: no reverseCharge field in Abra's schema yet (defaults false),
   and no separate debit-note collection was found. */
function mapLine(item) {
  return {
    description: item.itemDetails || '',
    hsn: item.hsnCode || item.sacCode || '',
    qty: item.quantity || 0,
    unitPrice: item.rate || 0,
    taxableValue: item.taxableAmount || item.amount || 0,
    gstRate: item.itemGstRate || 0,
    cess: 0,
    declared: { cgst: item.cgstAmount || 0, sgst: item.sgstAmount || 0, igst: item.igstAmount || 0 },
  };
}
function mapAbraInvoice(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance', sourceOrgId, sourceBranchId, sourceId: String(doc._id),
    type: 'SALE', docType: 'INVOICE',
    invoiceNumber: doc.invoiceNumber || '',
    invoiceDate: doc.invoiceDate ? new Date(doc.invoiceDate).toISOString().slice(0, 10) : '',
    period: doc.invoiceDate ? new Date(doc.invoiceDate).toISOString().slice(0, 7) : '',
    fy: doc.invoiceDate ? fyOf(new Date(doc.invoiceDate).toISOString().slice(0, 10)) : '',
    partyName: doc.customerName || '', partyGSTIN: doc.customerGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply), reverseCharge: false,
    // Abra's totalAmount is already net of TDS/TCS (e.g. totalAmount =
    // taxableTotal + totalTax - tdsAmount + tcsAmount) — reverse that so
    // declaredTotal is the pre-TDS, GST-inclusive figure the engine expects,
    // otherwise every invoice with TDS trips a false TOTAL_MISMATCH.
    // Verified against a real invoice: 162400 + 2800 - 0 = 165200, matching
    // the engine's own computed total exactly.
    declaredTotal: (doc.totalAmount != null) ? doc.totalAmount + (doc.tdsAmount || 0) - (doc.tcsAmount || 0) : (doc.grandTotal ?? null),
    lines: (doc.items || []).map(mapLine), updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}
function mapAbraCreditNote(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance', sourceOrgId, sourceBranchId, sourceId: String(doc._id),
    type: 'SALE', docType: 'CREDIT_NOTE',
    invoiceNumber: doc.creditNoteNumber || '',
    invoiceDate: doc.creditNoteDate ? new Date(doc.creditNoteDate).toISOString().slice(0, 10) : '',
    period: doc.creditNoteDate ? new Date(doc.creditNoteDate).toISOString().slice(0, 7) : '',
    fy: doc.creditNoteDate ? fyOf(new Date(doc.creditNoteDate).toISOString().slice(0, 10)) : '',
    partyName: doc.customerName || '', partyGSTIN: doc.customerGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply), reverseCharge: false,
    originalInvoiceNumber: doc.originalInvoiceNumber || doc.invoiceNumber || '',
    // Abra's totalAmount is already net of TDS/TCS (e.g. totalAmount =
    // taxableTotal + totalTax - tdsAmount + tcsAmount) — reverse that so
    // declaredTotal is the pre-TDS, GST-inclusive figure the engine expects,
    // otherwise every invoice with TDS trips a false TOTAL_MISMATCH.
    // Verified against a real invoice: 162400 + 2800 - 0 = 165200, matching
    // the engine's own computed total exactly.
    declaredTotal: (doc.totalAmount != null) ? doc.totalAmount + (doc.tdsAmount || 0) - (doc.tcsAmount || 0) : (doc.grandTotal ?? null),
    lines: (doc.items || []).map(mapLine), updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}
function mapAbraBill(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance', sourceOrgId, sourceBranchId, sourceId: String(doc._id),
    type: 'PURCHASE', docType: 'INVOICE',
    invoiceNumber: doc.billNumber || '',
    invoiceDate: doc.billDate ? new Date(doc.billDate).toISOString().slice(0, 10) : '',
    period: doc.billDate ? new Date(doc.billDate).toISOString().slice(0, 7) : '',
    fy: doc.billDate ? fyOf(new Date(doc.billDate).toISOString().slice(0, 10)) : '',
    partyName: doc.vendorName || '', partyGSTIN: doc.vendorGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply), reverseCharge: false,
    // Abra's totalAmount is already net of TDS/TCS (e.g. totalAmount =
    // taxableTotal + totalTax - tdsAmount + tcsAmount) — reverse that so
    // declaredTotal is the pre-TDS, GST-inclusive figure the engine expects,
    // otherwise every invoice with TDS trips a false TOTAL_MISMATCH.
    // Verified against a real invoice: 162400 + 2800 - 0 = 165200, matching
    // the engine's own computed total exactly.
    declaredTotal: (doc.totalAmount != null) ? doc.totalAmount + (doc.tdsAmount || 0) - (doc.tcsAmount || 0) : (doc.grandTotal ?? null),
    lines: (doc.items || []).map(mapLine), updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

async function runSync() {
  const mappingsSnap = await db.collection('orgMappings').get();
  if (mappingsSnap.empty) {
    console.log('No orgMappings configured in Firestore — nothing to sync.');
    return;
  }

  const client = new MongoClient(process.env.SOURCE_MONGO_URI);
  await client.connect();
  let totalSynced = 0;

  try {
    for (const mappingDoc of mappingsSnap.docs) {
      const mapping = mappingDoc.data();
      const { sourceOrgId, sourceBranchId, businessId, dbName } = mapping;
      if (!sourceOrgId || !sourceBranchId || !businessId) {
        console.warn(`orgMappings/${mappingDoc.id} is missing a required field — skipped.`);
        continue;
      }

      const bizSnap = await db.doc(`businesses/${businessId}`).get();
      if (!bizSnap.exists) {
        console.warn(`orgMappings/${mappingDoc.id} points at businesses/${businessId}, which doesn't exist — skipped.`);
        continue;
      }
      const biz = bizSnap.data();

      const sourceDb = client.db(dbName || 'abra_finance_module');
      const since = mapping.lastSyncedAt ? mapping.lastSyncedAt.toDate() : new Date(0);

      // Load existing auto-detected issues once, grouped by which invoice
      // they belong to — mirrors the web app's syncIssues(): each issue is
      // its own document (id = `${invoiceId}__${code}`) so re-syncing the
      // same invoice updates/reopens/resolves issues instead of duplicating
      // them, exactly like the app does when you edit an invoice by hand.
      const issuesSnap = await db.collection(`businesses/${businessId}/issues`).where('auto', '==', true).get();
      const existingIssuesByInvoice = new Map();
      issuesSnap.forEach(d => {
        const data = d.data();
        if (!existingIssuesByInvoice.has(data.transactionId)) existingIssuesByInvoice.set(data.transactionId, new Map());
        existingIssuesByInvoice.get(data.transactionId).set(data.code, { id: d.id, ...data });
      });

      const jobs = [
        { collection: 'invoices', mapper: mapAbraInvoice },
        { collection: 'creditnotes', mapper: mapAbraCreditNote },
        { collection: 'bills', mapper: mapAbraBill },
      ];

      for (const job of jobs) {
        const docs = await sourceDb.collection(job.collection).find({
          orgId: sourceOrgId,
          branchId: sourceBranchId,
          $or: [{ updatedAt: { $gt: since } }, { createdAt: { $gt: since } }],
        }).toArray();

        for (const raw of docs) {
          const inv = job.mapper(raw, sourceOrgId, sourceBranchId);
          const docId = `${inv.sourceSystem}_${inv.sourceId}`;
          const ev = evaluateInvoice(
            { ...inv, id: docId },
            { biz, invoices: [], twoB: new Map(), twoBPeriods: new Set(), periods: {}, payments: {}, today: new Date().toISOString().slice(0, 10) }
          );
          await db.doc(`businesses/${businessId}/invoices/${docId}`).set({
            ...inv, evaluation: ev, syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          const now = admin.firestore.FieldValue.serverTimestamp();
          const existingForThisInvoice = existingIssuesByInvoice.get(docId) || new Map();
          for (const is of ev.issues) {
            const issueId = `${docId}__${is.code}`;
            const ex = existingForThisInvoice.get(is.code);
            existingForThisInvoice.delete(is.code);
            const ref = db.doc(`businesses/${businessId}/issues/${issueId}`);
            if (!ex) {
              await ref.set({
                auto: true, code: is.code, type: is.code, severity: is.severity, description: is.description,
                transactionId: docId, invoiceNumber: inv.invoiceNumber || '', invoiceType: inv.type,
                partyName: inv.partyName || '', period: inv.period, fy: inv.fy,
                status: 'OPEN', resolution: null, resolvedBy: null, resolvedAt: null, detectedAt: now, updatedAt: now,
              });
            } else if (ex.status === 'RESOLVED') {
              await ref.update({ status: 'OPEN', severity: is.severity, description: is.description, resolution: 'Re-opened: condition detected again', resolvedBy: null, resolvedAt: null, updatedAt: now });
            } else if (ex.description !== is.description || ex.severity !== is.severity || ex.period !== inv.period || ex.invoiceNumber !== inv.invoiceNumber) {
              await ref.update({ severity: is.severity, description: is.description, period: inv.period, invoiceNumber: inv.invoiceNumber || '', updatedAt: now });
            }
          }
          // Anything left in existingForThisInvoice no longer applies — the
          // condition that caused it is gone, so auto-resolve it, exactly
          // like the app does.
          for (const ex of existingForThisInvoice.values()) {
            if (['OPEN', 'UNDER_REVIEW'].includes(ex.status)) {
              await db.doc(`businesses/${businessId}/issues/${ex.id}`).update({
                status: 'RESOLVED', resolution: 'Auto-resolved — condition no longer present', resolvedBy: 'System', resolvedAt: now, updatedAt: now,
              });
            }
          }

          totalSynced++;
          console.log(`  synced ${job.collection} ${inv.invoiceNumber} (${ev.status}, ${ev.issues.length} issue(s))`);
        }
      }

      await mappingDoc.ref.update({ lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } finally {
    await client.close();
  }

  console.log(`\nDone — ${totalSynced} record(s) synced across ${mappingsSnap.size} mapping(s).`);
}

runSync().catch(e => { console.error('Sync failed:', e); process.exit(1); });
