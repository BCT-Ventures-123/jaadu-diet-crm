// Turns a courier-aggregator report (Shiprocket / NimbusPost CSV) into clean rows.
// Column names differ between reports, so each field accepts several common header names.
const ALIASES = {
  awb: ['awb', 'awb number', 'awb no', 'awb code', 'awb nos', 'tracking number', 'tracking no', 'waybill', 'waybill number'],
  amount: ['cod amount', 'remitted amount', 'remittance amount', 'amount remitted', 'cod remitted', 'cod remittance amount', 'settled amount', 'net amount', 'amount', 'payable amount', 'cod payable'],
  utr: ['utr', 'utr number', 'utr no', 'utr nos', 'transaction id', 'transaction number', 'reference number', 'reference no', 'remittance id', 'crf id'],
  date: ['remittance date', 'settlement date', 'remitted on', 'paid date', 'payment date', 'date'],
  charged: ['charged weight', 'billed weight', 'applied weight', 'weight charged', 'charged wt', 'charged weight kg', 'applied weight kg'],
  actual: ['declared weight', 'actual weight', 'entered weight', 'weight declared', 'dead weight', 'your weight', 'seller weight'],
  excess: ['excess weight charge', 'excess charge', 'weight discrepancy charge', 'extra charge', 'additional charge', 'excess weight charges', 'weight charges'],
  courier: ['courier', 'courier name', 'courier company', 'courier partner'],
};

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// headers -> { field: columnIndex }, plus the headers nobody matched (shown to the user on failure).
function mapColumns(headers) {
  const map = {};
  const normalized = headers.map(norm);
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const i = normalized.indexOf(n);
      if (i !== -1) { map[field] = i; break; }
    }
  }
  const used = new Set(Object.values(map));
  return { map, unrecognised: headers.filter((_, i) => !used.has(i)).map(h => String(h).trim()).filter(Boolean) };
}

function toNumber(v) {
  if (v == null) return null;
  const s = String(v).replace(/[₹,\s]|rs\.?|inr/gi, '');
  if (s === '' || isNaN(Number(s))) return null;
  return Number(s);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// Returns YYYY-MM-DD or null. Indian reports use day-first dates.
function toDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]*(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}

const cell = (r, map, f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());

function remittanceRows(rows, map) {
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const awb = cell(r, map, 'awb');
    const amount = toNumber(cell(r, map, 'amount'));
    if (!awb || amount === null) { skipped++; continue; }
    out.push({ awb, amount, utr: cell(r, map, 'utr') || null, date: toDate(cell(r, map, 'date')), courier: cell(r, map, 'courier') || null });
  }
  return { rows: out, skipped };
}

// unit 'kg' (default for aggregator reports) or 'gm'. Only rows where the courier charged MORE than declared are disputable.
function weightRows(rows, map, unit = 'kg') {
  const k = unit === 'gm' ? 1 : 1000;
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const awb = cell(r, map, 'awb');
    const charged = toNumber(cell(r, map, 'charged'));
    const actual = toNumber(cell(r, map, 'actual'));
    if (!awb || charged === null || actual === null) { skipped++; continue; }
    const chargedGm = Math.round(charged * k), actualGm = Math.round(actual * k);
    if (chargedGm <= actualGm) { skipped++; continue; }
    out.push({
      awb, chargedGm, actualGm, diffGm: chargedGm - actualGm,
      excess: toNumber(cell(r, map, 'excess')) || 0, courier: cell(r, map, 'courier') || null,
    });
  }
  return { rows: out, skipped };
}

module.exports = { mapColumns, remittanceRows, weightRows, toNumber, toDate };
