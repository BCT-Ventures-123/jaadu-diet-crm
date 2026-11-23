// Pure helpers for the courier status webhook (Shiprocket and NimbusPost). No database here, so it is unit-tested.

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// What the courier said, as one of our statuses. Returns null when the text does not change anything we track
// (pickup scheduled, label created ...). Order of the checks matters: "undelivered" and "rto delivered" contain "deliver".
function classify(text) {
  const t = str(text).toLowerCase().replace(/[_-]+/g, ' ');
  if (!t) return null;
  if (/\b(out for pickup|pickup (scheduled|booked|exception|error|rescheduled|generated)|awb assigned|label generated|manifest(ed)? generated|order placed|new)\b/.test(t) && !/rto/.test(t)) return null;
  if (/rto/.test(t) || /return to (origin|seller)/.test(t)) {
    if (/deliver/.test(t) && !/undeliver|out for/.test(t)) return 'rto_delivered';
    if (/in transit|ofd|out for|reached|ndr|undeliver/.test(t)) return 'rto_in_transit';
    return 'rto_initiated';
  }
  if (/undeliver|not deliver|ndr|delivery (attempt )?(failed|unsuccessful)|attempt(ed)? (failed|unsuccessful)|delivery exception|consignee (unavailable|refused)|customer (unavailable|refused)|refused/.test(t)) return 'ndr';
  if (/out for delivery|\bofd\b/.test(t)) return 'out_for_delivery';
  if (/deliver/.test(t)) return 'delivered';
  if (/\blost\b|missing/.test(t)) return 'lost';
  if (/destroy|damag/.test(t)) return 'damaged';
  if (/cancel/.test(t)) return 'courier_cancelled';
  if (/picked up|pickup done|in transit|shipped|dispatched|reached|hub|arrived|departed|forwarded|handed over|manifest/.test(t)) return 'shipped';
  return null;
}

// The courier's own time ("11 11 2026 11:22:17" from Shiprocket, or an ISO string) as a Date, read as India time when no zone is given.
function parseEventTime(v) {
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[ \/.-](\d{1,2})[ \/.-](\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${(m[6] || '00').padStart(2, '0')}+05:30`);
    return isNaN(d) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + '+05:30');
    return isNaN(d) ? null : d;
  }
  return null;
}

function parsePayload(body) {
  const b = body || {};
  const scans = Array.isArray(b.scans) ? b.scans : Array.isArray(b.tracking_data) ? b.tracking_data : [];
  const last = scans.length ? scans[scans.length - 1] : {};
  const clean = (x) => str(x).replace(/^#/, '');
  const refs = [b.channel_order_id, b.order_number, b.reference_number, b.order_id, b.client_order_id, b.order_name]
    .map(clean).filter(Boolean);
  const statusText = str(b.current_status || b.status || b.shipment_status || b.event || last.status || '');
  const shipText = str(b.shipment_status || '');
  return {
    awb: str(b.awb || b.awb_number || b.tracking_number),
    courier: str(b.courier_name || b.courier || b.courier_company),
    refs: [...new Set(refs)],
    srOrderId: str(b.sr_order_id),
    nimbusOrderId: str(b.nimbus_order_id),
    statusText,
    // The courier's headline text first; the second field is only used if the first says nothing we track.
    status: classify(statusText) || classify(shipText),
    statusId: str(b.current_status_id || b.status_code),
    shipmentStatusId: str(b.shipment_status_id),
    reason: str(last.reason || last.status_remark || b.reason || b.status_remark || b.ndr_reason || ''),
    eventAt: parseEventTime(b.current_timestamp || b.timestamp || b.event_time || b.updated_at || last.date),
  };
}

// Names the order may have in our table for one reference from the courier.
const nameVariants = (refs) => [...new Set(refs.flatMap(r => [r, '#' + r]))];

// A repeat of the same courier event must not count twice. Without a courier time the key falls back to the hour received.
function eventKey(status, text, eventAt, now = new Date()) {
  const when = eventAt ? eventAt.toISOString() : 'rx-' + now.toISOString().slice(0, 13);
  return [status, str(text).toLowerCase(), when].join('|');
}

// A late scan must not move a finished order back: delivered stays delivered, and an RTO order does not return to "shipped".
function shouldApply(current, next) {
  const cur = str(current);
  if (cur === 'delivered') return false;
  if (cur === 'rto' && ['shipped', 'ndr', 'out_for_delivery', 'delivered'].includes(next)) return false;
  return true;
}

module.exports = { classify, parseEventTime, parsePayload, nameVariants, eventKey, shouldApply };
