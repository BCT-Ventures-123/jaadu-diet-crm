// Shipping messages on WhatsApp (owner 2026-11-25): prepaid order confirmation, out for delivery (OFD) and delivery failed (NDR).
// The CRM decides, the WhatsApp bridge only sends (same queue / check / result as the COD messages, see lib/waBridge.js). Every message is stored in wa_messages under its own name:
//   prepaid_confirm | ofd_1, ofd_2 | ndr_1, ndr_2, ndr_3        (steps 10 to 15, so they never mix with the five COD confirmation messages, steps 0 to 4)
// Where the facts come from: the CRM already scans Shiprocket with the Shiprocket login (lib/shiprocket.js, every 10 minutes) and keeps the orders that are "out for delivery" and "undelivered / NDR".
// syncSeen() writes what each scan saw into wa_courier_seen (when an order was first seen out for delivery or undelivered, and when it was last seen). Messages are driven from that table, so a restart or a repeated scan never sends twice:
// one row per message name in wa_messages (send_id = order id + name) is the lock.
// Mode and switches: WA_MODE (off | test | on) as for COD, WA_NOTIFY_KEYS (the names that may go out, EMPTY = none, the safe default), WA_NOTIFY_GO_LIVE (only events seen after this moment are messaged, so the orders already out for delivery at go-live are not blasted).
const wa = require('./waBridge');
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && v !== null && Number.isFinite(n) ? n : d; };
const plain = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^["']|["']$/g, '').trim();

const KEYS = ['prepaid_confirm', 'ofd_1', 'ofd_2', 'ndr_1', 'ndr_2', 'ndr_3'];
const STEP = { prepaid_confirm: 10, ofd_1: 11, ofd_2: 12, ndr_1: 13, ndr_2: 14, ndr_3: 15 };
const KIND_KEYS = { prepaid: ['prepaid_confirm'], ofd: ['ofd_1', 'ofd_2'], ndr: ['ndr_1', 'ndr_2', 'ndr_3'] };
const kindOfKey = (k) => (k === 'prepaid_confirm' ? 'prepaid' : String(k).startsWith('ofd_') ? 'ofd' : String(k).startsWith('ndr_') ? 'ndr' : null);
const CLOSED = ['delivered', 'cancelled', 'rto', 'returned', 'lost'];      // the order is over: nothing more is sent
const LABEL = { prepaid_confirm: 'Prepaid order confirmation', ofd_1: 'Out for delivery: 1st message', ofd_2: 'Out for delivery: 2nd message, 2 hours later', ndr_1: 'Delivery failed: 1st attempt', ndr_2: 'Delivery failed: 2nd attempt', ndr_3: 'Delivery failed: 3rd attempt' };
const SAMPLE = { customer_name: 'Test', order_name: '#TEST', product: 'Arjuna Cardio Care Tea', amount: '599' };

function settings(env = process.env) {
  const s = wa.settings(env);
  const goLive = plain(env.WA_NOTIFY_GO_LIVE) ? new Date(plain(env.WA_NOTIFY_GO_LIVE)) : null;
  return {
    ...s, notifyKeys: plain(env.WA_NOTIFY_KEYS).toLowerCase().split(/[,\s;]+/).filter(k => KEYS.includes(k)),
    notifyGoLive: goLive && !isNaN(goLive) ? goLive : null,
    ofdGapHours: num(plain(env.WA_OFD_GAP_HOURS), 2),            // the 2nd out-for-delivery message goes 2 hours after the 1st, only while the order is still out for delivery
    ndrGapHours: num(plain(env.WA_NDR_GAP_HOURS), 12),           // least time between two delivery-failed messages for one order
    freshHours: num(plain(env.WA_NOTIFY_FRESH_HOURS), 36),       // an out-for-delivery / failed-delivery event older than this is not messaged any more
    seenMinutes: num(plain(env.WA_NOTIFY_SEEN_MINUTES), 40),     // the order must have been in the latest courier scan (scans run every 10 minutes)
    prepaidMaxAgeH: num(plain(env.WA_PREPAID_MAX_AGE_H), 12),    // a prepaid order older than this at go-live or after a long outage is not messaged
    pace: Math.max(1, num(plain(env.WA_NOTIFY_PACE), 30)),       // most shipping messages offered in one poll
  };
}

// One order and its history -> what to do now. Pure.
//   f: { kind: 'prepaid'|'ofd'|'ndr', phone, opted_out, total_price, order_status, confirmation_status, created_at, rows: [{ key, status, sent_at, lease_until, error_code }],
//        episode_start, episodes, last_seen_at }       (episode_*, last_seen_at: from wa_courier_seen, ofd / ndr only)
// Returns { action: 'offer' | 'wait' | 'stop', key, step, reason, not_before }
function decide(f, now, s) {
  const t = new Date(now).getTime(), kind = f.kind, keys = KIND_KEYS[kind];
  if (!keys) return { action: 'stop', reason: 'unknown_kind' };
  if (f.opted_out) return { action: 'stop', reason: 'opted_out' };
  if (!wa.waNumber(f.phone)) return { action: 'stop', reason: 'bad_phone' };
  if ((Number(f.total_price) || 0) < s.minAmount) return { action: 'stop', reason: 'small_order' };
  if (CLOSED.includes(String(f.order_status || '').toLowerCase()) || f.confirmation_status === 'cancelled') return { action: 'stop', reason: 'order_closed' };
  const rows = (f.rows || []).filter(r => keys.includes(r.key));
  if ((f.rows || []).some(r => wa.UNREACHABLE.includes(String(r.error_code || '')))) return { action: 'stop', reason: 'not_on_whatsapp' };
  if (rows.some(r => r.status === 'failed')) return { action: 'stop', reason: 'send_failed' };
  const live = rows.find(r => r.status === 'leased' && r.lease_until && new Date(r.lease_until).getTime() > t);
  if (live) return { action: 'wait', reason: 'leased' };
  const sent = rows.filter(r => r.status === 'sent').sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  const open = rows.find(r => ['queued', 'skipped', 'leased'].includes(r.status));     // not sent yet (or a lease that ran out): offer the same message again, the sender de-duplicates by send_id
  const lastSentMs = sent.length ? new Date(sent[sent.length - 1].sent_at).getTime() : 0;
  let key = open ? open.key : null;

  if (kind === 'prepaid') {
    if (sent.length) return { action: 'stop', reason: 'already_sent' };
    if (f.created_at && t - new Date(f.created_at).getTime() > s.prepaidMaxAgeH * 3600e3) return { action: 'stop', reason: 'too_old' };
    if (s.notifyGoLive && f.created_at && new Date(f.created_at) < s.notifyGoLive) return { action: 'stop', reason: 'before_go_live' };
    key = 'prepaid_confirm';
  } else {
    // out for delivery / delivery failed: the event must be recent, after go-live, and the order must still be in the latest courier scan
    if (!f.episode_start) return { action: 'stop', reason: 'no_courier_event' };
    const ep = new Date(f.episode_start).getTime();
    if (s.notifyGoLive && ep < s.notifyGoLive.getTime()) return { action: 'stop', reason: 'before_go_live' };
    if (t - ep > s.freshHours * 3600e3) return { action: 'stop', reason: 'too_old' };
    if (!f.last_seen_at || t - new Date(f.last_seen_at).getTime() > s.seenMinutes * 60e3) return { action: 'wait', reason: 'not_in_latest_scan' };
    if (kind === 'ofd') {
      if (!key) { if (!sent.length) key = 'ofd_1'; else if (sent.length >= 2) return { action: 'stop', reason: 'all_sent' }; else key = 'ofd_2'; }
      if (key === 'ofd_2') {                                                // the 2nd message: 2 hours after the 1st, also when the sender asks for a message that was queued earlier
        const due = lastSentMs + s.ofdGapHours * 3600e3;
        if (!sent.length || t < due) return { action: 'wait', reason: 'not_yet', not_before: sent.length ? new Date(due) : undefined };
      }
    } else {
      if (!key) { if (sent.length >= 3) return { action: 'stop', reason: 'all_sent' }; key = KIND_KEYS.ndr[sent.length]; }
      const idx = KIND_KEYS.ndr.indexOf(key);
      if (Number(f.episodes || 0) < idx + 1) return { action: 'wait', reason: 'no_new_attempt' };       // one message per failed attempt the courier reported
      if (idx > 0 && t < lastSentMs + s.ndrGapHours * 3600e3) return { action: 'wait', reason: 'not_yet', not_before: new Date(lastSentMs + s.ndrGapHours * 3600e3) };
    }
    if (wa.inQuiet(t, s)) return { action: 'wait', reason: 'quiet_hours', not_before: wa.quietEnds(t, s) };       // never at night
  }
  if (!s.notifyKeys.includes(key)) return { action: 'wait', reason: 'template_not_enabled' };
  return { action: 'offer', key, step: STEP[key], reason: kind };
}

let ready = false;
async function ensureTables(db) {
  if (ready) return;
  await wa.ensureTables(db);
  await db(`CREATE TABLE IF NOT EXISTS wa_courier_seen (
    order_id UUID NOT NULL, kind TEXT NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, episode_start TIMESTAMPTZ NOT NULL, episodes INT NOT NULL DEFAULT 1, courier_status TEXT,
    PRIMARY KEY (order_id, kind))`);
  await db(`CREATE INDEX IF NOT EXISTS wa_courier_seen_kind_idx ON wa_courier_seen (kind, last_seen_at)`);
  // What the customer chose after an out-for-delivery / delivery-failed message (sent by the old bot's flow): the alternate number, the time slot, the reschedule date, the new address.
  await db(`CREATE TABLE IF NOT EXISTS wa_ship_replies (id BIGSERIAL PRIMARY KEY, order_id UUID, order_name TEXT, kind TEXT NOT NULL, detail TEXT, label TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS wa_ship_replies_order_idx ON wa_ship_replies (order_id, at)`);
  ready = true;
}

const REPLY_LABEL = { alt_number: (d) => 'Alternate number ' + d, slot: (d) => 'Reattempt ' + d, reschedule: (d) => 'Rescheduled to ' + d, address: (d) => 'New address: ' + d };
const labelOf = (kind, detail) => { const f = REPLY_LABEL[kind]; return f ? f(String(detail || '').slice(0, 200)) : String(detail || kind).slice(0, 200); };
// Save one answer (event ship_reply from the bridge). m = the order's wa_messages-like row (order_id, order_name).
async function saveReply(db, m, b, at) {
  const kind = String(b.kind || '').slice(0, 30);
  if (!m.order_id || !REPLY_LABEL[kind]) return 'recorded';
  await ensureTables(db);
  await db(`INSERT INTO wa_ship_replies (order_id, order_name, kind, detail, label, at) VALUES ($1, $2, $3, $4, $5, $6)`, [m.order_id, m.order_name || null, kind, String(b.text || '').slice(0, 300), labelOf(kind, b.text), at]);
  return 'reply_saved';
}
const _reset = () => { ready = false; };

// The orders a courier scan found: items = [{ channel_order_id, status }] (Shiprocket order lists), kind = 'ofd' | 'ndr'. Only orders placed in the last 7 days and known to the CRM are kept.
// An order that comes back after being away for 6 hours or more is a NEW episode (the courier tried again): that is what lets a second failed attempt get its own message.
async function syncSeen(db, items, kind, now = new Date()) {
  await ensureTables(db);
  const byName = new Map();
  for (const it of items || []) {
    const id = String(it.channel_order_id || '').replace(/^#/, '').trim();
    if (!/^\d{3,12}$/.test(id)) continue;
    const st = String(it.status || '').toUpperCase();
    if (kind === 'ndr' && /\bRTO\b|RETURN/.test(st)) continue;            // being returned to us: a delivery-failed message no longer helps
    byName.set('#' + id, st);
  }
  if (!byName.size) return { kind, seen: 0 };
  const rows = await db(`SELECT id, order_name FROM orders_master WHERE order_name = ANY($1) AND created_at >= $2`, [[...byName.keys()], new Date(new Date(now).getTime() - 7 * 86400e3)]);
  if (!rows.length) return { kind, seen: 0 };
  const ids = rows.map(r => r.id), sts = rows.map(r => byName.get(r.order_name) || '');
  await db(`INSERT INTO wa_courier_seen (order_id, kind, first_seen_at, last_seen_at, episode_start, episodes, courier_status)
      SELECT x.id, $2::text, $3::timestamptz, $3::timestamptz, $3::timestamptz, 1, x.st FROM unnest($1::uuid[], $4::text[]) AS x(id, st)
      ON CONFLICT (order_id, kind) DO UPDATE SET
        episodes = CASE WHEN wa_courier_seen.last_seen_at < $3::timestamptz - INTERVAL '6 hours' THEN wa_courier_seen.episodes + 1 ELSE wa_courier_seen.episodes END,
        episode_start = CASE WHEN wa_courier_seen.last_seen_at < $3::timestamptz - INTERVAL '6 hours' THEN $3::timestamptz ELSE wa_courier_seen.episode_start END,
        last_seen_at = $3::timestamptz, courier_status = EXCLUDED.courier_status`, [ids, kind, new Date(now), sts]);
  return { kind, seen: rows.length };
}

// Called every 5 minutes by the web service with the Shiprocket lists (lib/shiprocket.js getLists). Skips when the scan is stale or not loaded yet.
async function syncFromShiprocket(db, lists, now = new Date()) {
  if (!lists || !lists.updatedAt || new Date(now).getTime() - lists.updatedAt > 25 * 60e3) return { skipped: 'scan_not_fresh' };
  const a = await syncSeen(db, lists.ofd, 'ofd', now), b = await syncSeen(db, lists.undelivered, 'ndr', now);
  return { ofd: a.seen, ndr: b.seen };
}

const productOf = (li) => { try { const a = typeof li === 'string' ? JSON.parse(li) : li; const t = a && a[0] && (a[0].title || a[0].name); return t ? String(t).slice(0, 80) : null; } catch (e) { return null; } };

// The orders that may need one of the three messages, with their message history attached (one query for all histories).
async function candidates(db, kind, now, s, onlyId) {
  const t = new Date(now).getTime();
  const common = `o.id, o.order_name, o.customer_name, o.customer_phone AS phone, o.total_price, o.created_at, o.order_status, o.confirmation_status, o.line_items,
      EXISTS (SELECT 1 FROM wa_optouts p WHERE p.phone10 = right(regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g'), 10)) AS opted_out`;
  let list;
  if (kind === 'prepaid') {
    const since = new Date(Math.max(s.notifyGoLive ? s.notifyGoLive.getTime() : 0, t - s.prepaidMaxAgeH * 3600e3));
    list = await db(`/* notify:prepaid */ SELECT ${common}, NULL::timestamptz AS episode_start, 0 AS episodes, NULL::timestamptz AS last_seen_at FROM orders_master o
        WHERE UPPER(COALESCE(o.payment_method, 'COD')) <> 'COD' AND o.created_at >= $1 AND COALESCE(o.total_price, 0) >= $2 AND COALESCE(o.is_blacklisted, FALSE) = FALSE
          AND COALESCE(o.confirmation_status, '') <> 'cancelled' AND o.wrong_number_at IS NULL${onlyId ? ' AND o.id = $3' : ''} ORDER BY o.created_at LIMIT 500`, onlyId ? [since, s.minAmount, onlyId] : [since, s.minAmount]);
  } else {
    const since = new Date(Math.max(s.notifyGoLive ? s.notifyGoLive.getTime() : 0, t - s.freshHours * 3600e3));
    list = await db(`/* notify:${kind} */ SELECT ${common}, c.episode_start, c.episodes, c.last_seen_at FROM wa_courier_seen c JOIN orders_master o ON o.id = c.order_id
        WHERE c.kind = $1 AND c.episode_start >= $2 AND c.last_seen_at >= $3${onlyId ? ' AND o.id = $4' : ''} ORDER BY c.episode_start LIMIT 500`,
      onlyId ? [kind, since, new Date(t - s.seenMinutes * 60e3), onlyId] : [kind, since, new Date(t - s.seenMinutes * 60e3)]);
  }
  if (!list.length) return [];
  const hist = await db(`/* notify:history */ SELECT order_id, send_id, template_key AS key, status, sent_at, lease_until, error_code FROM wa_messages WHERE order_id = ANY($1) AND step >= 10 AND NOT is_test`, [list.map(r => r.id)]);
  const by = new Map();
  for (const h of hist) { if (!by.has(h.order_id)) by.set(h.order_id, []); by.get(h.order_id).push(h); }
  return list.map(r => ({ ...r, kind, rows: by.get(r.id) || [] }));
}

const variablesOf = (f) => ({ customer_name: String(f.customer_name || '').trim().split(/\s+/)[0] || 'Customer', order_name: f.order_name || '', amount: String(Math.round(Number(f.total_price) || 0)), product: productOf(f.line_items) || 'Arjuna Cardio Care Tea' });

// Items for the sender. Called by waBridge.queue after the COD messages; each item is leased so a second poll does not return it.
async function queueItems(db, now, s, room, lease, leaseUntil) {
  const out = [];
  if (!s.notifyKeys.length || s.mode === 'off' || room <= 0) return out;
  if (s.mode === 'on' && !s.notifyGoLive) return out;                      // real orders need the go-live moment
  await ensureTables(db);
  const max = Math.min(room, s.pace);
  for (const kind of ['prepaid', 'ofd', 'ndr']) {
    if (!KIND_KEYS[kind].some(k => s.notifyKeys.includes(k))) continue;
    for (const f of await candidates(db, kind, now, s)) {
      if (out.length >= max) return out;
      const p10 = wa.last10(f.phone);
      if (s.mode === 'test' && !s.testNumbers.includes(p10)) continue;
      const d = decide(f, now, s);
      if (d.action !== 'offer') continue;
      const row = { send_id: `${f.id}-${d.key}`, order_id: f.id, order_name: f.order_name, phone10: p10, step: d.step, template_key: d.key, variables: variablesOf(f) };
      if (await lease(row)) out.push({ send_id: row.send_id, order_id: f.id, order_name: f.order_name, step: d.step, template_key: d.key, to: wa.waNumber(f.phone), variables: row.variables, lease_until: leaseUntil.toISOString() });
    }
  }
  return out;
}

// Final go / no-go right before a send. m = the wa_messages row.
async function check(db, m, now = new Date(), env = process.env) {
  const s = settings(env), kind = kindOfKey(m.template_key);
  if (!kind || !m.order_id) return { send: false, reason: 'unknown_message' };
  if (s.mode === 'test' && !s.testNumbers.includes(m.phone10)) return { send: false, reason: 'test_mode' };
  const f = (await candidates(db, kind, now, s, m.order_id))[0];
  if (!f) return { send: false, reason: 'no_longer_due' };
  const mine = { key: m.template_key, status: 'queued', sent_at: null, lease_until: null, error_code: null };
  const d = decide({ ...f, rows: [...f.rows.filter(r => r.key !== m.template_key), mine] }, now, s);   // judge this message as if it were not sent yet
  if (d.action === 'offer' && d.key === m.template_key) return { send: true };
  return { send: false, reason: d.reason || 'not_due' };
}

// What the customer's reply to an OFD / NDR message does in the CRM. The order is usually shipped, so this never touches the confirmation: it only gives the order a callback so a caller phones the customer.
// Owner 2026-11-25: the customer's answers are handled by the OLD WhatsApp flow (time slot, reschedule, new address or phone, with the Shopify note and tag), exactly as before.
// So the CRM only RECORDS the taps (for the report); it creates no callback and changes nothing on the order.
const NDR_NOTE = {};
async function applyReply() { return 'recorded'; }

// The report rows: one per message name, for messages created on the chosen dates (India time).
async function report(db, from, to) {
  await ensureTables(db);
  const rows = await db(`SELECT m.template_key AS key,
      COUNT(DISTINCT m.send_id) FILTER (WHERE m.sent_at IS NOT NULL)::int AS sent, COUNT(DISTINCT m.send_id) FILTER (WHERE m.delivered_at IS NOT NULL)::int AS delivered, COUNT(DISTINCT m.send_id) FILTER (WHERE m.read_at IS NOT NULL)::int AS read,
      COUNT(DISTINCT m.send_id) FILTER (WHERE m.status = 'failed')::int AS failed,
      COUNT(DISTINCT m.send_id) FILTER (WHERE e.event IN ('clicked_ndr_yes', 'clicked_ndr_no', 'clicked_ofd_alt'))::int AS tapped,
      COUNT(DISTINCT m.send_id) FILTER (WHERE e.event = 'clicked_ndr_yes')::int AS ndr_yes, COUNT(DISTINCT m.send_id) FILTER (WHERE e.event = 'clicked_ndr_no')::int AS ndr_no,
      COUNT(DISTINCT m.send_id) FILTER (WHERE e.event = 'clicked_ofd_alt')::int AS ofd_alt
    FROM wa_messages m LEFT JOIN wa_events e ON e.send_id = m.send_id
    WHERE NOT m.is_test AND m.step >= 10 AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date GROUP BY m.template_key`, [from, to]);
  const by = new Map(rows.map(r => [r.key, r]));
  return KEYS.map(k => ({ key: k, label: LABEL[k], ...(by.get(k) || { sent: 0, delivered: 0, read: 0, failed: 0, tapped: 0, ndr_yes: 0, ndr_no: 0, ofd_alt: 0 }) }));
}

// The latest answers for the report: one row each, newest first, for answers given on the chosen dates (India time).
async function replies(db, from, to, limit = 40) {
  await ensureTables(db);
  return db(`SELECT order_name, kind, label, at FROM wa_ship_replies WHERE (at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date ORDER BY at DESC LIMIT $3`, [from, to, limit]);
}

module.exports = { settings, decide, syncSeen, syncFromShiprocket, candidates, queueItems, check, applyReply, saveReply, replies, labelOf, report, ensureTables, variablesOf, productOf, kindOfKey, _reset, KEYS, STEP, KIND_KEYS, LABEL, SAMPLE, NDR_NOTE };
