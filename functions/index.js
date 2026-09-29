// ============================================================================
// TAXPILOT CLOUD FUNCTIONS — the API layer TaxPilot didn't have before.
// Abra Finance (Billing_backend) is NOT modified for this — these functions
// read Abra's MongoDB directly as an external reader, and everything specific
// to "which source systems exist and how their data maps in" lives here, not
// inside Abra's own codebase. Any future module is added the same way: a new
// entry in the `orgMappings` Firestore collection, no code changes required
// on that module's side either, as long as it's MongoDB-backed the same way.
//
// STILL NEEDED BEFORE THIS CAN RUN:
//   1. `firebase deploy --only functions` from an account with access to the
//      taxpilot-ai-d68c0 project (I don't have that access).
//   2. Two secrets set via `firebase functions:secrets:set`:
//        SOURCE_MONGO_URI   — read-only connection string to a source DB
//        TAXPILOT_API_KEY   — the key other modules must send as x-api-key
//   3. One document in the `orgMappings` Firestore collection per source org
//      you want synced (see mapping shape below).
// ============================================================================

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const { evaluateInvoice, STATE_CODES } = require('./gstEngine');

admin.initializeApp();
const db = admin.firestore();

const SOURCE_MONGO_URI = defineSecret('SOURCE_MONGO_URI');
const TAXPILOT_API_KEY = defineSecret('TAXPILOT_API_KEY');

// STATE_CODES in gstEngine.js is {code: name}; Abra stores placeOfSupply as a
// state NAME string, TaxPilot's engine expects the 2-digit CODE — build the
// reverse lookup once.
const STATE_NAME_TO_CODE = Object.fromEntries(
  Object.entries(STATE_CODES).map(([code, name]) => [name.toLowerCase(), code])
);
function stateNameToCode(name) {
  return STATE_NAME_TO_CODE[String(name || '').trim().toLowerCase()] || '';
}

function requireApiKey(req, res) {
  const key = req.get('x-api-key');
  if (!key || key !== TAXPILOT_API_KEY.value()) {
    res.status(401).json({ error: 'Missing or invalid x-api-key.' });
    return false;
  }
  return true;
}

/* =====================================================================
   FIELD MAPPING — Abra Finance's schema -> TaxPilot's invoice shape.
   Verified against Billing_backend/routes/invoices.js, credit-notes.js and
   bill.js on 2026-09-26. Two known gaps, called out where they apply:
     - reverseCharge: no such field exists in Abra's Invoice/Bill schema
       today. Defaults to false here. If Abra ever adds it, wire it through.
     - DEBIT_NOTE: Abra has no separate debit-note collection that was found;
       only invoices, credit notes, and bills. Left unmapped for now.
   ===================================================================== */
function mapLine(item) {
  return {
    description: item.itemDetails || '',
    hsn: item.hsnCode || item.sacCode || '',
    qty: item.quantity || 0,
    unitPrice: item.rate || 0,
    taxableValue: item.taxableAmount || item.amount || 0,
    gstRate: item.itemGstRate || 0,
    cess: 0,
    declared: {
      cgst: item.cgstAmount || 0,
      sgst: item.sgstAmount || 0,
      igst: item.igstAmount || 0,
    },
  };
}

function mapAbraInvoice(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance',
    sourceOrgId,
    sourceBranchId,
    sourceId: String(doc._id),
    type: 'SALE',
    docType: 'INVOICE',
    invoiceNumber: doc.invoiceNumber || '',
    invoiceDate: doc.invoiceDate ? new Date(doc.invoiceDate).toISOString().slice(0, 10) : '',
    period: doc.invoiceDate ? new Date(doc.invoiceDate).toISOString().slice(0, 7) : '',
    partyName: doc.customerName || '',
    partyGSTIN: doc.customerGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply),
    reverseCharge: false, // Abra has no reverse-charge field yet — see note above
    declaredTotal: doc.totalAmount ?? doc.grandTotal ?? null,
    lines: (doc.items || []).map(mapLine),
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

function mapAbraCreditNote(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance',
    sourceOrgId,
    sourceBranchId,
    sourceId: String(doc._id),
    type: 'SALE',
    docType: 'CREDIT_NOTE',
    invoiceNumber: doc.creditNoteNumber || '',
    invoiceDate: doc.creditNoteDate ? new Date(doc.creditNoteDate).toISOString().slice(0, 10) : '',
    period: doc.creditNoteDate ? new Date(doc.creditNoteDate).toISOString().slice(0, 7) : '',
    partyName: doc.customerName || '',
    partyGSTIN: doc.customerGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply),
    reverseCharge: false,
    originalInvoiceNumber: doc.originalInvoiceNumber || doc.invoiceNumber || '',
    declaredTotal: doc.totalAmount ?? doc.grandTotal ?? null,
    lines: (doc.items || []).map(mapLine),
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

function mapAbraBill(doc, sourceOrgId, sourceBranchId) {
  return {
    sourceSystem: 'abra-finance',
    sourceOrgId,
    sourceBranchId,
    sourceId: String(doc._id),
    type: 'PURCHASE',
    docType: 'INVOICE',
    invoiceNumber: doc.billNumber || '',
    invoiceDate: doc.billDate ? new Date(doc.billDate).toISOString().slice(0, 10) : '',
    period: doc.billDate ? new Date(doc.billDate).toISOString().slice(0, 7) : '',
    partyName: doc.vendorName || '',
    partyGSTIN: doc.vendorGSTIN || '',
    placeOfSupply: stateNameToCode(doc.placeOfSupply),
    reverseCharge: false, // same gap as invoices — no field in Abra's Bill schema yet
    declaredTotal: doc.totalAmount ?? doc.grandTotal ?? null,
    lines: (doc.items || []).map(mapLine),
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

/* =====================================================================
   SYNC — pulls from every mapped source org, evaluates each doc through
   the same deterministic engine the web app uses, and upserts it into
   Firestore under businesses/{businessId}/invoices/{sourceSystem_sourceId}.

   orgMappings/{mappingId} shape:
     { sourceSystem: 'abra-finance', sourceOrgId: '<mongo orgId>',
       sourceBranchId: '<mongo branchId — GSTIN lives here, not on the org>',
       businessId: '<taxpilot business doc id>', dbName: 'abra_finance_module',
       lastSyncedAt: <Firestore Timestamp, set by this function> }
   ===================================================================== */
async function runSync() {
  const mappingsSnap = await db.collection('orgMappings').get();
  if (mappingsSnap.empty) {
    logger.info('No orgMappings configured — nothing to sync.');
    return { synced: 0, mappings: 0 };
  }

  const client = new MongoClient(SOURCE_MONGO_URI.value());
  await client.connect();
  let totalSynced = 0;

  try {
    for (const mappingDoc of mappingsSnap.docs) {
      const mapping = mappingDoc.data();
      const { sourceOrgId, sourceBranchId, businessId, dbName } = mapping;
      if (!sourceOrgId || !sourceBranchId || !businessId) {
        logger.warn(`orgMappings/${mappingDoc.id} is missing sourceOrgId, sourceBranchId, or businessId — skipped.`);
        continue;
      }

      const bizSnap = await db.doc(`businesses/${businessId}`).get();
      if (!bizSnap.exists) {
        logger.warn(`orgMappings/${mappingDoc.id} points at businesses/${businessId}, which doesn't exist — skipped.`);
        continue;
      }
      const biz = bizSnap.data();

      const sourceDb = client.db(dbName || 'abra_finance_module'); // Abra's real DB name, verified against Billing_backend/.env
      const since = mapping.lastSyncedAt ? mapping.lastSyncedAt.toDate() : new Date(0);

      const jobs = [
        { collection: 'invoices', mapper: mapAbraInvoice },
        { collection: 'creditnotes', mapper: mapAbraCreditNote },
        { collection: 'bills', mapper: mapAbraBill },
      ];

      for (const job of jobs) {
        // Scoped by orgId AND branchId — GSTIN lives on the branch in Abra's
        // data model, not the org (confirmed: some orgs have branches with
        // different GSTINs), so a TaxPilot "business" maps to one branch,
        // never a whole org.
        const cursor = sourceDb.collection(job.collection).find({
          orgId: sourceOrgId,
          branchId: sourceBranchId,
          $or: [{ updatedAt: { $gt: since } }, { createdAt: { $gt: since } }],
        });
        const docs = await cursor.toArray();

        for (const raw of docs) {
          const inv = job.mapper(raw, sourceOrgId, sourceBranchId);
          const docId = `${inv.sourceSystem}_${inv.sourceId}`;
          const ev = evaluateInvoice(
            { ...inv, id: docId },
            { biz, invoices: [], twoB: new Map(), twoBPeriods: new Set(), periods: {}, payments: {}, today: new Date().toISOString().slice(0, 10) }
          );
          await db.doc(`businesses/${businessId}/invoices/${docId}`).set({
            ...inv,
            evaluation: ev,
            syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          totalSynced++;
        }
      }

      await mappingDoc.ref.update({ lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  } finally {
    await client.close();
  }

  logger.info(`Sync complete — ${totalSynced} record(s) across ${mappingsSnap.size} mapping(s).`);
  return { synced: totalSynced, mappings: mappingsSnap.size };
}

// Runs every 15 minutes automatically once deployed.
exports.scheduledSync = onSchedule(
  { schedule: 'every 15 minutes', secrets: [SOURCE_MONGO_URI] },
  async () => { await runSync(); }
);

// Manual trigger for testing — same logic, callable over HTTP with the API key.
exports.syncNow = onRequest(
  { secrets: [SOURCE_MONGO_URI, TAXPILOT_API_KEY] },
  async (req, res) => {
    if (!requireApiKey(req, res)) return;
    try {
      const result = await runSync();
      res.json({ success: true, ...result });
    } catch (e) {
      logger.error(e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

/* =====================================================================
   STATELESS VALIDATION — for a one-off check without becoming a synced
   source org. POST { business: {...}, invoice: {...} } -> the same
   evaluateInvoice() result the web app itself would compute. Nothing is
   stored; this is pure compute.
   ===================================================================== */
exports.validateInvoice = onRequest(
  { secrets: [TAXPILOT_API_KEY] },
  (req, res) => {
    if (!requireApiKey(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
    const { business, invoice } = req.body || {};
    if (!business || !invoice) return res.status(400).json({ error: '"business" and "invoice" are both required.' });
    try {
      const ev = evaluateInvoice(
        { ...invoice, id: invoice.id || 'stateless-check' },
        { biz: business, invoices: [], twoB: new Map(), twoBPeriods: new Set(), periods: {}, payments: {}, today: new Date().toISOString().slice(0, 10) }
      );
      res.json({ success: true, evaluation: ev });
    } catch (e) {
      logger.error(e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);
