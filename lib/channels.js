// Who confirmed / cancelled orders, by channel: Aman, call centre, IVR, WhatsApp.
// Calls come from lead_call_log (agent calls). IVR and WhatsApp results come from order_status_events,
// written by the Google Sheet sync with actor = 'whatsapp' | 'ivr_call' | 'sheet' | '*_late'.
const WA = ['whatsapp', 'whatsapp_late'];
const IVR = ['ivr_call', 'ivr_late'];
const SHEET = ['sheet'];
const SHEET_SOURCES = [...WA, ...IVR, ...SHEET];

const channelOf = (actor) => (WA.includes(actor) ? 'whatsapp' : IVR.includes(actor) ? 'ivr' : SHEET.includes(actor) ? 'sheet' : 'other');
const num = (v) => Number(v) || 0;
const zeroCalls = () => ({ calls: 0, orders_called: 0, connected: 0, confirmed: 0, cancelled: 0, address_fix: 0, dnp: 0, callbacks: 0 });

// callRows: [{ role, calls, orders_called, connected, confirmed, cancelled, address_fix, dnp, callbacks }]
// eventRows: [{ actor, event_type, n }]
function shapeChannels(callRows, eventRows) {
  const out = { aman: zeroCalls(), cc: zeroCalls(), admin: zeroCalls(),
    ivr: { results: 0, answered: 0, confirmed: 0, cancelled: 0, no_answer: 0 },
    whatsapp: { replies: 0, confirmed: 0, cancelled: 0 }, sheet: { confirmed: 0, cancelled: 0 }, other: { confirmed: 0, cancelled: 0 } };
  for (const r of callRows) {
    const k = r.role === 'aman' ? 'aman' : r.role === 'agent' ? 'cc' : 'admin';
    for (const f of Object.keys(out[k])) out[k][f] += num(r[f]);
  }
  for (const e of eventRows) {
    const ch = channelOf(e.actor), n = num(e.n);
    if (ch === 'ivr') {
      if (e.event_type === 'confirmed') out.ivr.confirmed += n;
      else if (e.event_type === 'cancelled') out.ivr.cancelled += n;
      else if (e.event_type === 'rnr') out.ivr.no_answer += n;
    } else if (ch === 'whatsapp') {
      if (e.event_type === 'confirmed') out.whatsapp.confirmed += n;
      else if (e.event_type === 'cancelled') out.whatsapp.cancelled += n;
    } else if (e.event_type === 'confirmed' || e.event_type === 'cancelled') {
      out[ch][e.event_type] += n;
    }
  }
  out.ivr.answered = out.ivr.confirmed + out.ivr.cancelled;
  out.ivr.results = out.ivr.answered + out.ivr.no_answer;
  out.whatsapp.replies = out.whatsapp.confirmed + out.whatsapp.cancelled;
  const sum = (f) => out.aman[f] + out.cc[f] + out.admin[f] + out.ivr[f] + out.whatsapp[f] + out.sheet[f] + out.other[f];
  out.total = { confirmed: sum('confirmed'), cancelled: sum('cancelled') };
  return out;
}

module.exports = { shapeChannels, channelOf, SHEET_SOURCES, WA, IVR };
