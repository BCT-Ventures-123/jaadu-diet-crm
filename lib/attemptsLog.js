// The ALL-ATTEMPTS log: one row per attempt on every channel (Aman, call centre, IVR, WhatsApp), so a download shows everything that was tried, not only the callers' calls.
// Pure functions; the route (cc_routes.js /api/cc/attempts-log.csv) loads the three sources.
//   callers: [{ t, channel: 'Aman'|'Call centre', by, order_id, order, phone, result, connected, reason, note }]
//   ivr:     [{ t, order_id, order, phone, result, status, key, connected, note }]
//   wa:      [{ t, order_id, order, phone, step, status, events: ['delivered', 'read', 'clicked_confirm', ...] }]
const HEAD = ['Time (India)', 'Channel', 'By', 'Order', 'Phone', 'Attempt number on this order', 'Result', 'Customer reached', 'Detail'];
const istStamp = (d) => new Date(new Date(d).getTime() + 19800000).toISOString().slice(0, 19).replace('T', ' ');
const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };

const DISP = { confirmed: 'Confirmed', cancelled: 'Cancelled', dnp: 'No answer (DNP)', callback: 'Callback asked', address_fix: 'Address fixed', wrong_number: 'Wrong number', dnc: 'Do not call', escalated: 'Escalated' };
const IVR_RESULT = { confirmed: 'Pressed 1: confirmed', address_change: 'Pressed 2: address change', cancel_requested: 'Pressed 3: cancel asked' };
const WA_REPLY = ['clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text'];
const WA_TEXT = { clicked_confirm: 'Tapped Confirm', clicked_cancel: 'Tapped Cancel', clicked_change_address: 'Tapped Change address', replied_text: 'Replied in writing', read: 'Read, no reply', delivered: 'Delivered, not read', sent: 'Sent, not delivered yet', failed: 'Could not be delivered' };

function waResult(m) {
  const ev = (m.events || []).map(String);
  for (const k of WA_REPLY) if (ev.includes(k)) return { text: WA_TEXT[k], reached: true };
  if (ev.includes('read')) return { text: WA_TEXT.read, reached: false };
  if (ev.includes('delivered')) return { text: WA_TEXT.delivered, reached: false };
  if (String(m.status) === 'failed') return { text: WA_TEXT.failed, reached: false };
  return { text: WA_TEXT.sent, reached: false };
}

function merge({ callers = [], ivr = [], wa = [] }) {
  const all = [];
  callers.forEach(c => all.push({ t: new Date(c.t), channel: c.channel, by: c.by || '', order_id: c.order_id, order: c.order || '', phone: last10(c.phone), result: DISP[c.result] || c.result || '', reached: !!c.connected, detail: [c.reason, c.note].filter(Boolean).join(' · ') }));
  ivr.forEach(i => all.push({ t: new Date(i.t), channel: 'IVR', by: 'IVR', order_id: i.order_id, order: i.order || '', phone: last10(i.phone), result: IVR_RESULT[i.result] || (i.result ? String(i.result) : 'Called, no key pressed'), reached: !!i.connected, detail: i.note || '' }));
  wa.forEach(m => { const r = waResult(m); all.push({ t: new Date(m.t), channel: 'WhatsApp', by: 'WhatsApp message ' + (Number(m.step) + 1), order_id: m.order_id, order: m.order || '', phone: last10(m.phone), result: r.text, reached: r.reached, detail: '' }); });
  all.sort((a, b) => a.t - b.t);
  const seq = new Map();
  return all.map(x => { const k = x.order_id || x.order; seq.set(k, (seq.get(k) || 0) + 1); return { ...x, n: seq.get(k) }; });
}

const csvRows = (rows) => rows.map(x => [istStamp(x.t), x.channel, x.by, x.order, x.phone, x.n, x.result, x.reached ? 'Yes' : 'No', x.detail]);

module.exports = { merge, csvRows, waResult, HEAD, istStamp };
