// Customers who asked to cancel on the IVR (key 3) or WhatsApp (Cancel button). The order is NOT cancelled: it is a callback due at once for a caller, who tries to save it and cancels only if the customer says so on the call
// (lib/ivrDb.js followUp, lib/waBridge.js clicked_cancel). This lists the ones still waiting, so none is forgotten.
//   rows: [{ order, team: 'InHouse'|'CC', callback_at, callback_note, tries_since }]
const channelOfNote = (note) => { const n = String(note || ''); return /pressed 3/i.test(n) ? 'IVR' : /tapped .?Cancel/i.test(n) ? 'WhatsApp' : null; };

function summarize(rows, now = new Date()) {
  const list = rows.map(r => ({ order: r.order, channel: channelOfNote(r.callback_note), team: r.team === 'InHouse' ? 'Aman' : r.team === 'CC' ? 'Call centre' : 'Neither', asked_at: r.callback_at,
      waiting_hours: Math.round(Math.max(0, (new Date(now) - new Date(r.callback_at)) / 3600e3) * 10) / 10, calls_since: Number(r.tries_since) || 0 })).filter(x => x.channel);
  return { waiting: list.length, overdue_2h: list.filter(x => x.waiting_hours >= 2).length, never_called_since: list.filter(x => x.calls_since === 0).length,
    by_channel: { IVR: list.filter(x => x.channel === 'IVR').length, WhatsApp: list.filter(x => x.channel === 'WhatsApp').length }, list: list.sort((a, b) => b.waiting_hours - a.waiting_hours).slice(0, 30) };
}

module.exports = { channelOfNote, summarize };
