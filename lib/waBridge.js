// WhatsApp bridge: the CRM decides what to message and when; the WhatsApp project only sends and reports back (see the handoff pack, section 3).
//   GET  /api/wa/queue   -> messages to send now (leased 10 minutes)      GET /api/wa/check -> final go / no-go right before a send
//   POST /api/wa/result  -> sent / delivered / read / failed / skipped / clicked_* / replied_text / optout (idempotent)
// Timeline per COD order (owner 2026-11-23): message 0 at once (ANY hour), then a reminder 4 hours after the previous message was SENT, and a second reminder 4 hours after that: THREE messages a day, all with the SAME approved
// confirm template (keys confirm, reminder_1, reminder_2 all map to cod_order_confirm in the sender). Reminders are never sent at night (21:00-08:00 India time): one that falls due at night goes at 08:00.
// Never once the order is confirmed or cancelled by anybody, a person spoke to the customer in the last 3 hours (reminders only), the customer opted out, or asked for a change of address / cancel.
// (Owner 2026-11-23: no wait after an IVR call, no wait for a planned callback.)
// Mode: WA_MODE = off (queue always empty) | test (only the owner's test numbers) | on (real orders created after WA_GO_LIVE).
const crypto = require('crypto');
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && v !== null && Number.isFinite(n) ? n : d; };
const plain = (v) => String(v === undefined || v === null ? '' : v).trim().replace(/^["']|["']$/g, '').trim();
const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const waNumber = (p) => { const t = last10(p); return /^[6-9]\d{9}$/.test(t) ? '91' + t : null; };   // digits with country code, as the contract says
const KEYS = ['confirm', 'reminder_1', 'reminder_2', 'reminder_3'];
const EVENTS = ['sent', 'delivered', 'read', 'failed', 'skipped', 'clicked_confirm', 'clicked_change_address', 'clicked_cancel', 'replied_text', 'optout'];
const CONNECTED = ['confirmed', 'cancelled', 'callback', 'address_fix', 'dnc', 'escalated'];     // same as config.CONNECTED_DISPOSITIONS: a person really spoke to the customer
// Provider error codes that mean "this number cannot get WhatsApp": no more WhatsApp for the order (calls and IVR go on).
const UNREACHABLE = ['131026', '131021', '131047', '470', '1013'];

function settings(env = process.env) {
  const raw = plain(env.WA_MODE || 'off').toLowerCase();
  const mode = ['true', '1', 'yes', 'enabled', 'enable'].includes(raw) ? 'on' : raw;
  const tests = plain(env.WA_TEST_NUMBERS || env.IVR_TEST_NUMBERS || '').split(/[,\s;]+/).map(last10).filter(Boolean);
  const goLive = plain(env.WA_GO_LIVE) ? new Date(plain(env.WA_GO_LIVE)) : null;
  return {
    mode: ['off', 'test', 'on'].includes(mode) ? mode : 'off', key: plain(env.WA_SHARED_KEY),
    goLive: goLive && !isNaN(goLive) ? goLive : null, testNumbers: tests,
    quietFrom: num(plain(env.WA_QUIET_FROM), 21), quietTo: num(plain(env.WA_QUIET_TO), 8),
    reminderHours: num(plain(env.WA_REMINDER_HOURS), 4), maxReminders: Math.min(3, Math.max(0, num(plain(env.WA_MAX_REMINDERS), 2))),
    holdMinutes: Math.max(0, num(plain(env.WA_HOLD_MINUTES), 0)),            // a fixed head start for WhatsApp, whatever the callers are doing (0 = off, the default)
    busyHoldMinutes: Math.max(0, num(plain(env.WA_BUSY_HOLD_MINUTES), 30)),    // owner rule: when the team the order belongs to is busy or absent, WhatsApp gets this head start before a caller sees the order; when the callers have spare time they call in parallel
    personHours: num(plain(env.WA_PERSON_HOURS), 3), ivrGapMinutes: num(plain(env.WA_IVR_GAP_MINUTES), 60),
    // Only these messages are offered (same list as BRIDGE_ENABLED_KEYS on the WhatsApp service). Default: the first message and two reminders, all sent with the approved confirm template.
    enabledKeys: plain(env.WA_ENABLED_KEYS || 'confirm,reminder_1,reminder_2').toLowerCase().split(/[,\s;]+/).filter(k => KEYS.includes(k)),
    reminderMaxAgeH: num(plain(env.WA_REMINDER_MAX_AGE_H), 24),
    minAmount: num(plain(env.WA_MIN_AMOUNT), 350), leaseMinutes: num(plain(env.WA_LEASE_MINUTES), 10), batch: Math.min(200, Math.max(1, num(plain(env.WA_BATCH), 50))),
  };
}

const istHour = (t) => new Date(new Date(t).getTime() + 5.5 * 3600e3).getUTCHours();
function inQuiet(t, s) { const h = istHour(t); return s.quietFrom > s.quietTo ? (h >= s.quietFrom || h < s.quietTo) : (h >= s.quietFrom && h < s.quietTo); }
// the next moment the quiet hours end (08:00 India time)
function quietEnds(t, s) {
  const d = new Date(new Date(t).getTime() + 5.5 * 3600e3);
  let end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.quietTo, 0, 0);
  if (end <= d.getTime()) end += 86400e3;
  return new Date(end - 5.5 * 3600e3);
}

// One order, its WhatsApp history and its call history -> what to do with it right now. Pure.
//   f: { created_at, last_step, last_status, last_sent_at, last_lease_until, person_spoke_at, ivr_at, callback_at, wa_stop, opted_out, last_error, phone }
// Returns { action: 'offer' | 'wait' | 'stop', step, template_key, reason, not_before }
function decide(f, now, s) {
  const t = new Date(now).getTime();
  if (f.opted_out) return { action: 'stop', reason: 'opted_out' };
  if (f.wa_stop) return { action: 'stop', reason: 'customer_asked_for_a_person' };
  if (!waNumber(f.phone)) return { action: 'stop', reason: 'bad_phone' };
  // "Not on WhatsApp" often arrives AFTER the message was marked sent (a delivery-status webhook). It still ends WhatsApp for this order.
  if (UNREACHABLE.includes(String(f.last_error || ''))) return { action: 'stop', reason: 'not_on_whatsapp' };
  const hasMsg = f.last_step !== null && f.last_step !== undefined;
  let step = 0;
  if (hasMsg) {
    const st = String(f.last_status || '');
    if (st === 'failed') return { action: 'stop', reason: UNREACHABLE.includes(String(f.last_error || '')) ? 'not_on_whatsapp' : 'send_failed' };
    if (st === 'queued' || st === 'leased' || st === 'skipped') {
      if (st === 'leased' && f.last_lease_until && new Date(f.last_lease_until).getTime() > t) return { action: 'wait', reason: 'leased' };
      step = Number(f.last_step);                                   // not sent yet: offer the same message again (the sender de-duplicates by send_id)
    } else {                                                       // sent
      step = Number(f.last_step) + 1;
      if (step > s.maxReminders) return { action: 'stop', reason: 'all_reminders_sent' };
      if (t - new Date(f.last_sent_at).getTime() > s.reminderMaxAgeH * 3600e3) return { action: 'stop', reason: 'too_old' };   // a day later the callers own it
      const due = new Date(f.last_sent_at).getTime() + s.reminderHours * 3600e3;
      if (t < due) return { action: 'wait', reason: 'not_yet', not_before: new Date(due) };
    }
  }
  if (!s.enabledKeys.includes(KEYS[step])) return { action: 'wait', reason: 'template_not_enabled' };
  if (step > 0) {                                                  // reminders only: not right after a person really spoke to the customer, and never at night (the first message may go at any hour)
    if (f.person_spoke_at && t - new Date(f.person_spoke_at).getTime() < s.personHours * 3600e3) return { action: 'wait', reason: 'person_spoke_recently' };
    if (inQuiet(t, s)) return { action: 'wait', reason: 'quiet_hours', not_before: quietEnds(t, s) };
  }
  return { action: 'offer', step, template_key: KEYS[step], reason: step === 0 ? 'new_order' : 'reminder' };
}

const sendIdOf = (orderId, step) => `${orderId}-s${step}`;

// How long WhatsApp keeps a brand-new order to itself, before a caller may call. bw = { cc: pace, aman: pace } from autopilot (uncalled, capacity, active_agents); team = the order's team ('CC' | 'InHouse').
// Busy = nobody of that team is working, or it has more uncalled leads than it can call before the 2 PM deadline. A fixed WA_HOLD_MINUTES always wins. If the workload is unknown the callers are not held back.
function holdMinutes(team, bw, s) {
  if (s.holdMinutes > 0) return s.holdMinutes;
  const b = bw && bw[team === 'InHouse' ? 'aman' : 'cc'];
  if (!b) return 0;
  const busy = Number(b.active_agents) === 0 || Number(b.uncalled) > Number(b.capacity);
  return busy ? s.busyHoldMinutes : 0;
}

let ready = false;
async function ensureTables(db) {
  if (ready) return;
  await db(`CREATE TABLE IF NOT EXISTS wa_messages (
    send_id TEXT PRIMARY KEY, order_id UUID, order_name TEXT, phone10 TEXT, step INT NOT NULL DEFAULT 0, template_key TEXT, is_test BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'queued', leased_at TIMESTAMPTZ, lease_until TIMESTAMPTZ, sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, read_at TIMESTAMPTZ,
    provider_message_id TEXT, error_code TEXT, error_text TEXT, variables JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS wa_messages_order_idx ON wa_messages (order_id, step)`);
  await db(`CREATE INDEX IF NOT EXISTS wa_messages_provider_idx ON wa_messages (provider_message_id)`);
  await db(`CREATE TABLE IF NOT EXISTS wa_events (
    id BIGSERIAL PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, send_id TEXT, order_id UUID, event TEXT NOT NULL, provider_message_id TEXT, at TIMESTAMPTZ,
    error_code TEXT, error_text TEXT, text TEXT, applied TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS wa_events_order_idx ON wa_events (order_id, event)`);
  await db(`CREATE TABLE IF NOT EXISTS wa_optouts (phone10 TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE TABLE IF NOT EXISTS wa_flags (name TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  ready = true;
}
const _reset = () => { ready = false; };

async function hasIvrTable(db) { try { const r = await db(`SELECT to_regclass('ivr_calls') AS t`); return !!(r && r[0] && r[0].t); } catch (e) { return false; } }

// Real orders that may need a message. Only pending COD orders created after the go-live time; the rules above decide the rest.
async function candidates(db, now, s, onlyId) {
  const ivr = await hasIvrTable(db);
  const since = new Date(Math.max(s.goLive ? s.goLive.getTime() : 0, new Date(now).getTime() - 5 * 86400e3));
  return db(`SELECT o.id, o.order_name, o.customer_name, o.customer_phone AS phone, o.total_price, o.created_at, o.callback_at,
      o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_province, o.shipping_zip,
      m.step AS last_step, m.status AS last_status, m.sent_at AS last_sent_at, m.lease_until AS last_lease_until, m.error_code AS last_error,
      (SELECT MAX(l.created_at) FROM lead_call_log l WHERE l.order_id = o.id AND l.disposition = ANY($2)) AS person_spoke_at,
      ${ivr ? `(SELECT MAX(i.placed_at) FROM ivr_calls i WHERE i.order_id = o.id AND NOT i.is_test AND i.status IN ('placed', 'answered'))` : 'NULL::timestamptz'} AS ivr_at,
      EXISTS (SELECT 1 FROM wa_events e WHERE e.order_id = o.id AND e.event IN ('clicked_cancel', 'clicked_change_address', 'replied_text')) AS wa_stop,
      EXISTS (SELECT 1 FROM wa_optouts p WHERE p.phone10 = right(regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g'), 10)) AS opted_out
    FROM orders_master o
    LEFT JOIN LATERAL (SELECT w.step, w.status, w.sent_at, w.lease_until, w.error_code FROM wa_messages w WHERE w.order_id = o.id ORDER BY w.step DESC LIMIT 1) m ON TRUE
    WHERE o.confirmation_status = 'pending' AND UPPER(COALESCE(o.payment_method, 'COD')) = 'COD' AND COALESCE(o.total_price, 0) >= $3
      AND o.created_at >= $1 AND COALESCE(o.is_blacklisted, FALSE) = FALSE AND COALESCE(o.is_duplicate, FALSE) = FALSE
      AND COALESCE(o.dnc, FALSE) = FALSE AND o.wrong_number_at IS NULL${onlyId ? ' AND o.id = $4' : ''}
    ORDER BY o.created_at ASC LIMIT 3000`, onlyId ? [since, CONNECTED, s.minAmount, onlyId] : [since, CONNECTED, s.minAmount]);
}

// What the sender should send now. Marks each item as leased so a second poll does not return it again.
async function queue(db, now = new Date(), env = process.env, limit) {
  const s = settings(env);
  await ensureTables(db);
  const out = { now: new Date(now).toISOString(), mode: s.mode, items: [] };
  if (s.mode === 'off') return out;
  const max = Math.min(Number(limit) || s.batch, s.batch);
  const leaseUntil = new Date(new Date(now).getTime() + s.leaseMinutes * 60e3);
  const lease = async (row) => {
    const r = await db(`INSERT INTO wa_messages (send_id, order_id, order_name, phone10, step, template_key, is_test, status, leased_at, lease_until, variables)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'leased', $8, $9, $10)
        ON CONFLICT (send_id) DO UPDATE SET status = 'leased', leased_at = EXCLUDED.leased_at, lease_until = EXCLUDED.lease_until
        WHERE wa_messages.status IN ('queued', 'skipped') OR (wa_messages.status = 'leased' AND wa_messages.lease_until < $8) RETURNING send_id`,
      [row.send_id, row.order_id, row.order_name, row.phone10, row.step, row.template_key, !!row.is_test, new Date(now), leaseUntil, JSON.stringify(row.variables)]);
    return r.length > 0;
  };
  // 1) test messages the owner asked for (to his own numbers only)
  const tests = await db(`SELECT send_id, order_name, phone10, step, template_key, variables FROM wa_messages WHERE is_test AND (status = 'queued' OR (status = 'leased' AND lease_until < $1)) ORDER BY created_at LIMIT $2`, [new Date(now), max]);
  for (const t of tests) {
    if (out.items.length >= max) break;
    if (!s.testNumbers.includes(t.phone10)) continue;
    if (await lease({ ...t, order_id: null, is_test: true, variables: t.variables || {} })) out.items.push({ send_id: t.send_id, order_id: null, order_name: t.order_name, step: t.step, template_key: t.template_key, to: '91' + t.phone10, variables: t.variables || {}, lease_until: leaseUntil.toISOString() });
  }
  // 2) real orders
  if (s.mode === 'test' || (s.mode === 'on' && s.goLive)) {
    const rows = await candidates(db, now, s);
    for (const f of rows) {
      if (out.items.length >= max) break;
      const p10 = last10(f.phone);
      if (s.mode === 'test' && !s.testNumbers.includes(p10)) continue;
      const d = decide(f, now, s);
      if (d.action !== 'offer') continue;
      const address = [f.shipping_address1, f.shipping_address2, f.shipping_city, f.shipping_province, f.shipping_zip].map(x => String(x || '').trim()).filter(Boolean).join(', ');
      const variables = { customer_name: String(f.customer_name || '').trim().split(/\s+/)[0] || 'Customer', amount: String(Math.round(Number(f.total_price) || 0)), order_name: f.order_name || '', product: 'Arjuna Cardio Care Tea',
        delivery_address: (address || 'the address on your order').slice(0, 300) };
      const row = { send_id: sendIdOf(f.id, d.step), order_id: f.id, order_name: f.order_name, phone10: p10, step: d.step, template_key: d.template_key, variables };
      if (await lease(row)) out.items.push({ send_id: row.send_id, order_id: f.id, order_name: f.order_name, step: d.step, template_key: d.template_key, to: waNumber(f.phone), variables, lease_until: leaseUntil.toISOString() });
    }
  }
  return out;
}

// Final go / no-go right before a send. Looks at the order again, so a confirmation that happened a second ago still stops the message.
async function check(db, sendId, now = new Date(), env = process.env) {
  const s = settings(env);
  await ensureTables(db);
  if (s.mode === 'off') return { send: false, reason: 'mode_off' };
  const m = (await db(`SELECT * FROM wa_messages WHERE send_id = $1`, [String(sendId || '')]))[0];
  if (!m) return { send: false, reason: 'unknown_send_id' };
  if (m.status === 'sent') return { send: false, reason: 'already_sent' };
  if (m.status === 'failed') return { send: false, reason: 'failed_before' };
  if (m.is_test) return s.testNumbers.includes(m.phone10) ? { send: true } : { send: false, reason: 'not_a_test_number' };
  if (s.mode === 'test' && !s.testNumbers.includes(m.phone10)) return { send: false, reason: 'test_mode' };
  const rows = await candidates(db, now, s, m.order_id);
  const f = rows[0];
  if (!f) return { send: false, reason: 'order_no_longer_pending' };
  if (m.step > 0 && inQuiet(now, s)) return { send: false, reason: 'quiet_hours' };
  const d = decide({ ...f, last_step: m.step, last_status: 'queued', last_lease_until: null, last_sent_at: null }, now, s);   // judge this message as if it were not sent yet
  if (d.action === 'stop') return { send: false, reason: d.reason };
  if (m.step > 0 && d.action === 'wait') return { send: false, reason: d.reason };
  return { send: true };
}

const CLICK_NOTE = {
  clicked_change_address: 'WhatsApp: customer tapped "Change address". Please call back and fix the address.',
  clicked_cancel: 'WhatsApp: customer tapped "Cancel". Please call and try to save the order. Cancel it only if the customer says so on the call.',
};

// Save one event from the sender. The same (provider message id, event) twice changes nothing.
async function result(db, body, now = new Date(), env = process.env) {
  const s = settings(env);
  await ensureTables(db);
  const b = body || {};
  const event = String(b.event || ''), sendId = String(b.send_id || ''), pid = b.provider_message_id ? String(b.provider_message_id) : null;
  if (!EVENTS.includes(event)) return { status: 400, body: { ok: false, error: 'unknown_event' } };
  let m = sendId ? (await db(`SELECT * FROM wa_messages WHERE send_id = $1`, [sendId]))[0] : null;
  if (!m && pid) m = (await db(`SELECT * FROM wa_messages WHERE provider_message_id = $1 ORDER BY step DESC LIMIT 1`, [pid]))[0];
  // A button tapped on an OLD message (sent by the old COD flow): there is no send_id, only the Shopify order id. Find the order and treat the tap like any other (owner 2026-11-24).
  let legacy = false;
  if (!m && b.shopify_order_id && /^\d{6,20}$/.test(String(b.shopify_order_id)) && ['clicked_confirm', 'clicked_change_address', 'clicked_cancel'].includes(event)) {
    const o = (await db(`SELECT id, order_name, right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) AS phone10 FROM orders_master WHERE shopify_order_id::text = $1 LIMIT 1`, [String(b.shopify_order_id)]))[0];
    if (o) { m = { send_id: 'legacy-' + String(b.shopify_order_id), order_id: o.id, order_name: o.order_name, phone10: o.phone10, step: 0, is_test: false }; legacy = true; }
  }
  if (!m) return { status: 404, body: { ok: false, error: 'unknown_send_id' } };
  const at = b.at && !isNaN(new Date(b.at)) ? new Date(b.at) : new Date(now);
  const key = `${pid || m.send_id}|${event}`;
  const ins = await db(`INSERT INTO wa_events (dedupe_key, send_id, order_id, event, provider_message_id, at, error_code, error_text, text)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [key, m.send_id, m.order_id, event, pid, at, b.error_code == null ? null : String(b.error_code), b.error_text ? String(b.error_text).slice(0, 300) : null, b.text ? String(b.text).slice(0, 500) : null]);
  if (!ins.length) return { status: 200, body: { ok: true, duplicate: true, ...(legacy ? { order_name: m.order_name } : {}) } };
  let applied = 'recorded';
  if (event === 'sent') {
    await db(`UPDATE wa_messages SET status = 'sent', sent_at = COALESCE(sent_at, $2), provider_message_id = COALESCE($3, provider_message_id), lease_until = NULL WHERE send_id = $1 AND status <> 'sent'`, [m.send_id, at, pid]);
    if (m.order_id && m.step === 0) {                                              // WhatsApp's head start before the callers see the lead: only when that team is busy or absent (see holdMinutes)
      let hold = s.holdMinutes;
      if (!hold) { try { const o = (await db(`SELECT assigned_to FROM orders_master WHERE id = $1`, [m.order_id]))[0]; hold = holdMinutes(o && o.assigned_to, await require('./autopilotDb').bandwidth(db, new Date(now)), s); } catch (e) { hold = 0; } }
      if (hold > 0) await db(`UPDATE orders_master SET lead_locked_by = 'WHATSAPP', lead_locked_at = $2 WHERE id = $1 AND confirmation_status = 'pending' AND lead_locked_by IS NULL`,
        [m.order_id, new Date(at.getTime() + (hold - 15) * 60e3)]);                // the lock clears 15 minutes after lead_locked_at, so the hold ends "hold" minutes after the send
    }
  } else if (event === 'delivered') await db(`UPDATE wa_messages SET delivered_at = COALESCE(delivered_at, $2) WHERE send_id = $1`, [m.send_id, at]);
  else if (event === 'read') await db(`UPDATE wa_messages SET read_at = COALESCE(read_at, $2) WHERE send_id = $1`, [m.send_id, at]);
  else if (event === 'failed') await db(`UPDATE wa_messages SET status = CASE WHEN status = 'sent' THEN status ELSE 'failed' END, error_code = $2, error_text = $3 WHERE send_id = $1`, [m.send_id, b.error_code == null ? null : String(b.error_code), b.error_text ? String(b.error_text).slice(0, 300) : null]);   // a late "failed" status keeps the sent time (the 4-hour clock) but still records the code
  else if (event === 'skipped') await db(`UPDATE wa_messages SET status = 'skipped', lease_until = NULL WHERE send_id = $1 AND status = 'leased'`, [m.send_id]);
  else if (event === 'optout') { if (m.phone10) await db(`INSERT INTO wa_optouts (phone10) VALUES ($1) ON CONFLICT DO NOTHING`, [m.phone10]); applied = 'optout_saved'; }
  else if (!m.is_test && m.order_id) {
    if (event === 'clicked_confirm') {
      const upd = await db(`UPDATE orders_master SET confirmation_status = 'confirmed', confirmed_at = NOW(), lead_locked_by = NULL, lead_locked_at = NULL, updated_at = NOW()
                            WHERE id = $1 AND confirmation_status = 'pending' RETURNING id`, [m.order_id]);
      if (upd.length) { await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', 'whatsapp', $2)`, [m.order_id, 'via WhatsApp button, message ' + m.send_id]); applied = 'confirmed_order'; }
      else applied = 'order_not_pending';
    } else if (event === 'clicked_change_address' || event === 'clicked_cancel' || event === 'replied_text') {
      const note = event === 'replied_text' ? 'WhatsApp reply from the customer: "' + String(b.text || '').slice(0, 200) + '". Please call back.' : CLICK_NOTE[event];
      const upd = await db(`UPDATE orders_master SET callback_at = NOW(), callback_note = $2, lead_locked_by = CASE WHEN lead_locked_by = 'WHATSAPP' THEN NULL ELSE lead_locked_by END,
                            lead_locked_at = CASE WHEN lead_locked_by = 'WHATSAPP' THEN NULL ELSE lead_locked_at END, updated_at = NOW() WHERE id = $1 AND confirmation_status = 'pending' RETURNING id`, [m.order_id, note]);
      if (upd.length) { await db(`SELECT log_status_change($1, 'whatsapp_followup', NULL, $2, 'whatsapp', $3)`, [m.order_id, event, note]); applied = 'followup_set'; } else applied = 'order_not_pending';
    }
  }
  await db(`UPDATE wa_events SET applied = $2 WHERE id = $1`, [ins[0].id, applied]);
  return { status: 200, order_id: m.order_id || null, body: { ok: true, duplicate: false, applied, ...(legacy ? { order_name: m.order_name } : {}) } };
}

async function health(db, body, now = new Date()) {
  await ensureTables(db);
  const q = String((body || {}).quality || '').toUpperCase();
  await db(`INSERT INTO wa_flags (name, value) VALUES ('quality', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [q.slice(0, 10)]);
  await db(`INSERT INTO wa_flags (name, value) VALUES ('tier', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [String((body || {}).tier || '').slice(0, 30)]);
  return { ok: true };
}

// A test message to one of the owner's own numbers (never an order). At most 10 an hour.
async function testMessage(db, slot, key = 'confirm', now = new Date(), env = process.env) {
  const s = settings(env);
  await ensureTables(db);
  const p10 = s.testNumbers[Number(slot)];
  if (!p10) return { ok: false, message: 'That test number is not set up (WA_TEST_NUMBERS or IVR_TEST_NUMBERS)' };
  if (!KEYS.includes(key)) return { ok: false, message: 'Unknown message' };
  const recent = await db(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE is_test AND created_at > $1`, [new Date(new Date(now).getTime() - 3600e3)]);
  if (recent[0] && recent[0].n >= 10) return { ok: false, message: 'Too many test messages in the last hour. Please wait.' };
  const id = 'test-' + crypto.randomBytes(5).toString('hex');
  await db(`INSERT INTO wa_messages (send_id, order_name, phone10, step, template_key, is_test, status, variables) VALUES ($1, $2, $3, $4, $5, TRUE, 'queued', $6)`,
    [id, 'TEST', p10, KEYS.indexOf(key), key, JSON.stringify({ customer_name: 'Test', amount: '599', order_name: 'TEST', product: 'Arjuna Cardio Care Tea', delivery_address: 'Test address, New Delhi 110001' })]);
  return { ok: true, message: s.mode === 'off' ? 'Queued, but WA_MODE is off: it will not go out until the mode is test or on' : 'Queued: the WhatsApp service sends it within a minute', send_id: id };
}

function safeEqual(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); }

// For the admin screens
async function status(db, now = new Date(), env = process.env) {
  const s = settings(env);
  await ensureTables(db);
  const day = new Date(new Date(now).getTime() - 24 * 3600e3);
  const msgs = await db(`SELECT template_key, status, COUNT(*)::int AS n FROM wa_messages WHERE NOT is_test AND created_at > $1 GROUP BY 1, 2`, [day]);
  const ev = await db(`SELECT event, COUNT(*)::int AS n FROM wa_events WHERE received_at > $1 GROUP BY 1`, [day]);
  const flags = await db(`SELECT name, value FROM wa_flags`);
  const recent = await db(`SELECT m.send_id, m.order_name, m.template_key, m.status, m.sent_at, m.error_code, m.is_test, m.created_at FROM wa_messages m ORDER BY m.created_at DESC LIMIT 25`);
  return { mode: s.mode, key_set: !!s.key, go_live: s.goLive, test_numbers: s.testNumbers.length, hold_minutes: s.holdMinutes, busy_hold_minutes: s.busyHoldMinutes, enabled_keys: s.enabledKeys, last_24h: { messages: msgs, events: ev }, flags: Object.fromEntries(flags.map(f => [f.name, f.value])), recent };
}

module.exports = { settings, decide, holdMinutes, queue, check, result, health, testMessage, status, safeEqual, waNumber, last10, inQuiet, quietEnds, sendIdOf, ensureTables, candidates, _reset, KEYS, EVENTS, UNREACHABLE };
