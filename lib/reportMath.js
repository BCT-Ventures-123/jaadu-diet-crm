const cfg = require('./config');

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

// counts: totals per disposition for a period/agent, e.g. { confirmed: 40, cancelled: 3, dnp: 20, ... }
function buildReport(counts, prepaidConversions = 0) {
  const c = (k) => Number(counts[k]) || 0;
  const totalAttempts = cfg.CALL_DISPOSITIONS.reduce((s, k) => s + c(k), 0);
  const connected = cfg.CONNECTED_DISPOSITIONS.reduce((s, k) => s + c(k), 0);
  const confirmed = c('confirmed');
  const cancelled = c('cancelled');
  const decided = confirmed + cancelled;

  const connectivity = pct(connected, totalAttempts);
  const cancelledPct = pct(cancelled, decided);

  return {
    total_attempts: totalAttempts,
    connected_calls: connected,
    confirmed,
    cancelled,
    dnp: c('dnp'),
    callbacks: c('callback'),
    address_fixes: c('address_fix'),
    wrong_numbers: c('wrong_number'),
    escalations: c('escalated'),
    prepaid_conversions: Number(prepaidConversions) || 0,
    decided_orders: decided,
    connectivity_pct: connectivity,
    cancelled_pct: cancelledPct,
    connectivity_target_pct: cfg.TARGET_CONNECTIVITY_PCT,
    cancelled_target_pct: cfg.TARGET_CANCELLED_PCT,
    connectivity_ok: connectivity === null ? null : connectivity >= cfg.TARGET_CONNECTIVITY_PCT,
    cancelled_ok: cancelledPct === null ? null : cancelledPct <= cfg.TARGET_CANCELLED_PCT,
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection from free-text fields.
  const safe = /^[=+\-@\t\r]/.test(s) && isNaN(Number(s)) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function toCsv(columns, rows) {
  const head = columns.map(csvEscape).join(',');
  const body = rows.map(r => columns.map(col => csvEscape(r[col])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

module.exports = { buildReport, toCsv, pct };
