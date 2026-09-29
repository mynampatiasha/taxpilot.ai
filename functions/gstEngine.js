// ============================================================================
// GST RULES ENGINE — ported from taxpilot-ai.html's window.TaxPilotEngine.
// Same deterministic logic, same function names, adapted from browser globals
// to a CommonJS module so Cloud Functions (and any future module) can require
// it directly instead of duplicating GST rules in every consuming system.
// ============================================================================

const round2 = n => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const pad = n => String(n).padStart(2, '0');
const normNo = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function isoOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000); }
function fyOf(iso) { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); const s = m >= 4 ? y : y - 1; return `${s}-${pad((s + 1) % 100)}`; }

/* =====================================================================
   GST MASTER DATA — identical to taxpilot-ai.html. Keep both copies in
   sync until the HTML app itself is refactored to load this module.
   ===================================================================== */
const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = GST_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}
function validateGSTIN(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { ok: false, empty: true, error: 'GSTIN is empty' };
  if (g.length !== 15) return { ok: false, error: 'must be 15 characters' };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { ok: false, error: 'invalid format' };
  if (!STATE_CODES[g.slice(0, 2)]) return { ok: false, error: `unknown state code ${g.slice(0, 2)}` };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, error: 'checksum digit does not match (typo?)' };
  return { ok: true, gstin: g, stateCode: g.slice(0, 2), state: STATE_CODES[g.slice(0, 2)], pan: g.slice(2, 12) };
}

/* Effective-dated GST rate master — verify against current CBIC notifications when rates change. */
const RATE_MASTER = [
  { validFrom: '2017-07-01', validTo: '2025-09-21', rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28], reviewRates: [] },
  { validFrom: '2025-09-22', validTo: null, rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40], reviewRates: [12, 28] }
];
const rateSlab = d => RATE_MASTER.find(r => d >= r.validFrom && (!r.validTo || d <= r.validTo)) || RATE_MASTER[RATE_MASTER.length - 1];

const itcDeadline = fy => `${+fy.slice(0, 4) + 1}-11-30`; // Section 16(4)
const reconKey = (docType, gstin, no) => `${docType || 'INVOICE'}|${gstin}|${normNo(no)}`;

function resolveStates(inv, biz) {
  const party = validateGSTIN(inv.partyGSTIN);
  let supplier, pos;
  if (inv.type === 'SALE') { supplier = biz.stateCode; pos = inv.placeOfSupply || (party.ok ? party.stateCode : biz.stateCode); }
  else { supplier = party.ok ? party.stateCode : (inv.supplierState || biz.stateCode); pos = inv.placeOfSupply || biz.stateCode; }
  return { supplier, pos, inter: supplier !== pos, party };
}

// ctx = { biz, invoices, twoB (Map keyed by reconKey), twoBPeriods (Set), periods, payments, today }
function evaluateInvoice(inv, ctx) {
  const { biz } = ctx; const isSale = inv.type === 'SALE'; const isComp = biz.registrationType === 'COMPOSITION';
  const issues = [];
  const add = (code, severity, description) => {
    const ex = issues.find(i => i.code === code);
    if (ex) ex.description += ' ' + description; else issues.push({ code, severity, description });
  };
  const st = resolveStates(inv, biz);
  const date = inv.invoiceDate || ctx.today;

  const lines = (inv.lines || []).map(l => {
    const taxable = round2(num(l.taxableValue)); const rate = num(l.gstRate);
    const tax = (isSale && isComp) ? 0 : round2(taxable * rate / 100);
    let cgst = 0, sgst = 0, igst = 0;
    if (st.inter) igst = tax; else { cgst = round2(tax / 2); sgst = round2(tax - cgst); }
    return { description: l.description || '', hsn: String(l.hsn || '').trim(), qty: num(l.qty), unitPrice: num(l.unitPrice),
      taxableValue: taxable, gstRate: rate, cgst, sgst, igst, cess: round2(num(l.cess)), declared: l.declared || null };
  });
  const t = lines.reduce((a, l) => { for (const k of ['taxableValue', 'cgst', 'sgst', 'igst', 'cess']) a[k] += l[k]; return a; }, { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 });
  for (const k in t) t[k] = round2(t[k]);
  t.totalTax = round2(t.cgst + t.sgst + t.igst + t.cess);
  t.totalAmount = round2(t.taxableValue + t.totalTax);

  if (!inv.invoiceNumber) add('MISSING_INVOICE_NUMBER', 'HIGH', 'Invoice number is missing.');
  else if (String(inv.invoiceNumber).length > 16 || !/^[A-Za-z0-9\/-]+$/.test(inv.invoiceNumber))
    add('INVALID_INVOICE_NUMBER', 'MEDIUM', 'Invoice number should be at most 16 characters using only letters, digits, "/" and "-" (Rule 46).');
  if (!inv.invoiceDate) add('MISSING_DATE', 'HIGH', 'Invoice date is missing.');
  else if (inv.invoiceDate > ctx.today) add('FUTURE_DATE', 'HIGH', 'Invoice date is in the future.');
  if (!String(inv.partyName || '').trim()) add('MISSING_PARTY', 'MEDIUM', `${isSale ? 'Customer' : 'Supplier'} name is missing.`);
  if (inv.partyGSTIN) {
    if (!st.party.ok) add('INVALID_GSTIN', 'HIGH', `${isSale ? 'Customer' : 'Supplier'} GSTIN ${inv.partyGSTIN}: ${st.party.error}.`);
    else if (st.party.gstin === biz.gstin) add('OWN_GSTIN', 'HIGH', 'Party GSTIN is the same as your own GSTIN.');
  } else if (!isSale && !inv.reverseCharge) add('MISSING_SUPPLIER_GSTIN', 'MEDIUM', 'Supplier GSTIN is missing — ITC cannot be claimed without it.');
  if ((inv.docType === 'CREDIT_NOTE' || inv.docType === 'DEBIT_NOTE') && !inv.originalInvoiceNumber)
    add('MISSING_ORIGINAL_INVOICE', 'LOW', 'Original invoice number is not recorded for this note.');
  if (!lines.length) add('NO_LINES', 'HIGH', 'Invoice has no line items.');
  if (isSale && isComp && lines.some(l => l.gstRate > 0))
    add('COMPOSITION_TAX', 'HIGH', 'Composition taxpayers cannot collect GST — issue a Bill of Supply with 0% tax.');

  const slab = rateSlab(date);
  lines.forEach((l, i) => {
    const n = `Line ${i + 1}:`;
    if (l.taxableValue <= 0) add('ZERO_VALUE', 'HIGH', `${n} taxable value must be greater than zero.`);
    if (!slab.rates.includes(l.gstRate)) add('INVALID_RATE', 'HIGH', `${n} ${l.gstRate}% is not a valid GST rate on ${date}.`);
    else if (slab.reviewRates.includes(l.gstRate)) add('RATE_REVIEW', 'MEDIUM', `${n} the ${l.gstRate}% slab was withdrawn for most goods from 22-09-2025 — verify the rate for HSN ${l.hsn || '(not given)'}.`);
    if (!l.hsn) add('HSN_MISSING', 'LOW', `${n} HSN/SAC code missing.`);
    else if (!/^\d{4,8}$/.test(l.hsn)) add('HSN_FORMAT', 'LOW', `${n} HSN/SAC "${l.hsn}" should be 4–8 digits.`);
    if (l.qty > 0 && l.unitPrice > 0 && Math.abs(round2(l.qty * l.unitPrice) - l.taxableValue) > 1)
      add('VALUE_CHECK', 'LOW', `${n} taxable value ${l.taxableValue} differs from qty × price ${round2(l.qty * l.unitPrice)} (discount?).`);
    if (l.declared) {
      const dI = num(l.declared.igst), dCS = num(l.declared.cgst) + num(l.declared.sgst);
      if (st.inter && dCS > 0) add('TAX_TYPE_MISMATCH', 'HIGH', `${n} CGST/SGST charged on an inter-state supply (IGST applies).`);
      else if (!st.inter && dI > 0) add('TAX_TYPE_MISMATCH', 'HIGH', `${n} IGST charged on an intra-state supply (CGST + SGST apply).`);
      const calc = round2(l.cgst + l.sgst + l.igst);
      if (Math.abs(round2(dI + dCS) - calc) > 1) add('TAX_AMOUNT_MISMATCH', 'HIGH', `${n} invoice shows tax ${dI + dCS}, but ${l.gstRate}% of ${l.taxableValue} = ${calc}.`);
    }
  });
  if (String(inv.declaredTotal ?? '').trim() !== '' && Math.abs(num(inv.declaredTotal) - t.totalAmount) > 1)
    add('TOTAL_MISMATCH', 'MEDIUM', `Invoice total ${num(inv.declaredTotal)} differs from computed total ${t.totalAmount}.`);

  const key = normNo(inv.invoiceNumber);
  if (key && inv.invoiceDate) {
    const fy = fyOf(inv.invoiceDate);
    const dup = (ctx.invoices || []).find(o => o.id !== inv.id && o.type === inv.type && (o.docType || 'INVOICE') === (inv.docType || 'INVOICE')
      && o.invoiceDate && fyOf(o.invoiceDate) === fy && normNo(o.invoiceNumber) === key
      && (isSale || (inv.partyGSTIN ? (o.partyGSTIN || '') === inv.partyGSTIN
        : (!o.partyGSTIN && String(o.partyName || '').trim().toLowerCase() === String(inv.partyName || '').trim().toLowerCase()))));
    if (dup) add('DUPLICATE_INVOICE', 'HIGH', `Possible duplicate of ${dup.invoiceNumber} dated ${dup.invoiceDate}${dup.partyName ? ' (' + dup.partyName + ')' : ''}.`);
  }

  let itcStatus = null, itcReason = '', reconStatus = null, recon = null;
  if (!isSale) {
    const bookTax = round2(t.igst + t.cgst + t.sgst);
    if (inv.reverseCharge) reconStatus = 'NOT_APPLICABLE';
    else if (st.party.ok) {
      const row = (ctx.twoB || new Map()).get(reconKey(inv.docType, st.party.gstin, inv.invoiceNumber));
      if (row) {
        const rowTax = round2(num(row.igst) + num(row.cgst) + num(row.sgst));
        recon = { taxableValue: num(row.taxableValue), tax: rowTax, period: row.period };
        const ok = Math.abs(rowTax - bookTax) <= 1 && Math.abs(num(row.taxableValue) - t.taxableValue) <= 1;
        reconStatus = ok ? 'MATCHED' : 'AMOUNT_MISMATCH';
        if (!ok) add('RECON_MISMATCH', 'HIGH', `GSTR-2B (${row.period}) shows taxable ${row.taxableValue} / tax ${rowTax}; books show ${t.taxableValue} / ${bookTax}.`);
      } else if ((ctx.twoBPeriods || new Set()).has(inv.period)) {
        reconStatus = 'MISSING_IN_2B';
        add('MISSING_IN_2B', 'MEDIUM', `Not found in GSTR-2B for ${inv.period} — supplier may not have filed GSTR-1, or invoice details differ.`);
      } else reconStatus = 'NOT_CHECKED';
    } else reconStatus = 'NOT_CHECKED';

    const pay = (ctx.payments || {})[inv.id] || {};
    const paid = pay.status === 'PAID';
    const rule37Due = inv.invoiceDate ? addDays(inv.invoiceDate, 180) : null;
    const claimed = ['APPROVED', 'FILED'].includes((ctx.periods || {})[inv.period]?.status);
    const deadline = inv.invoiceDate ? itcDeadline(fyOf(inv.invoiceDate)) : null;
    const hasDup = issues.some(i => i.code === 'DUPLICATE_INVOICE');

    if (isComp) { itcStatus = 'NOT_ELIGIBLE'; itcReason = 'Composition taxpayers cannot claim ITC.'; }
    else if (inv.itcCategory === 'PERSONAL') { itcStatus = 'NOT_ELIGIBLE'; itcReason = 'Not used for business.'; }
    else if (inv.itcCategory === 'BLOCKED') { itcStatus = 'BLOCKED'; itcReason = 'Blocked credit under Section 17(5).'; }
    else if (!inv.reverseCharge && !st.party.ok) { itcStatus = 'NOT_ELIGIBLE'; itcReason = 'A valid supplier GSTIN is required.'; }
    else if (!claimed && deadline && ctx.today > deadline) {
      itcStatus = 'NOT_ELIGIBLE'; itcReason = `Time-barred under Section 16(4) — deadline was ${deadline}.`;
      add('ITC_TIME_BARRED', 'HIGH', itcReason);
    }
    else if (!paid && rule37Due && ctx.today > rule37Due) {
      itcStatus = 'NEEDS_REVIEW'; itcReason = `Unpaid beyond 180 days (due ${rule37Due}) — ITC must be reversed under Rule 37 until paid.`;
      add('RULE_37', 'HIGH', itcReason);
    }
    else if (hasDup) { itcStatus = 'NEEDS_REVIEW'; itcReason = 'Possible duplicate invoice.'; }
    else if (inv.reverseCharge) { itcStatus = 'ELIGIBLE'; itcReason = 'Reverse charge — claim after paying the tax in cash.'; }
    else if (reconStatus === 'MATCHED') { itcStatus = 'ELIGIBLE'; itcReason = 'Matched with GSTR-2B.'; }
    else if (reconStatus === 'AMOUNT_MISMATCH') { itcStatus = 'MISMATCH'; itcReason = 'Amounts differ from GSTR-2B.'; }
    else if (reconStatus === 'MISSING_IN_2B') { itcStatus = 'NEEDS_REVIEW'; itcReason = 'Not reflected in GSTR-2B (Section 16(2)(aa)).'; }
    else { itcStatus = 'POTENTIALLY_ELIGIBLE'; itcReason = 'Awaiting GSTR-2B for this period.'; }

    if (!paid && rule37Due && itcStatus !== 'NEEDS_REVIEW' && ctx.today <= rule37Due && daysBetween(ctx.today, rule37Due) <= 30)
      add('RULE_37_DUE_SOON', 'MEDIUM', `Supplier payment due by ${rule37Due} to avoid ITC reversal under Rule 37.`);
  }

  const status = issues.some(i => i.severity === 'HIGH') ? 'HAS_ISSUES' : issues.some(i => i.severity === 'MEDIUM') ? 'REVIEW' : 'VALID';
  return { lines, totals: t, placeOfSupply: st.pos, supplierState: st.supplier, interState: st.inter, issues, itcStatus, itcReason, reconStatus, recon, status };
}

module.exports = { validateGSTIN, gstinCheckChar, rateSlab, RATE_MASTER, STATE_CODES, evaluateInvoice, resolveStates, fyOf, addDays, daysBetween, round2, num, normNo, reconKey };
