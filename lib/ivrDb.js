// Database side of the IVR plan (rules are in lib/ivrPlan.js). Stage 1 is read-only: it lists what the IVR could call, it places no calls.
const apDb = require('./autopilotDb');
const ivr = require('./ivrPlan');

// Leads placed since the start of November are in scope for the backlog wave, so look back 30 days.
async function plan(db, now = new Date(), env = process.env, opts = {}) {
  await ensureTables(db);
  const cover = opts.cover !== undefined ? opts.cover : await coverMode(db, now, env);   // nobody from Aman or the call centre is working: the plan, the window and the cap are the cover-day ones (see coverMode)
  if (cover && !opts.envReady) env = coverEnv(env);
  const [leads, state] = await Promise.all([apDb.loadLeads(db, { days: 30, limit: 8000, includeIvrLocked: true }), ivrState(db, now)]);
  const s = ivr.settings(env);
  if (s.waWaitMinutes > 0) await addWhatsApp(db, leads);
  // The daily cap counts real calls already placed today; the list shows only what is still allowed today.
  const used = await callsToday(db, now);
  return { plan: ivr.buildList({ now, leads, ivrByLead: state }, { ...s, dailyCap: Math.max(0, s.dailyCap - used) }), openLeads: leads.length, usedToday: used, dailyCap: s.dailyCap, cover };
}

// WhatsApp first (IVR_WA_WAIT_MINUTES): put on each lead when its first WhatsApp message went out and whether the customer already tapped or replied. Real messages only (no test, steps 0 to 4).
// If the WhatsApp tables cannot be read, the leads are left as they are and the wait counts from the order time.
async function addWhatsApp(db, leads) {
  try {
    const ids = leads.map(l => l.id); if (!ids.length) return;
    const [first, resp] = await Promise.all([
      db(`SELECT order_id, MIN(sent_at) AS first_at FROM wa_messages WHERE order_id = ANY($1) AND step = 0 AND NOT is_test AND sent_at IS NOT NULL GROUP BY order_id`, [ids]),
      db(`SELECT DISTINCT m.order_id FROM wa_events e JOIN wa_messages m ON m.send_id = e.send_id
          WHERE m.order_id = ANY($1) AND m.step <= 4 AND NOT m.is_test AND e.event IN ('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text')`, [ids])]);
    const f = new Map(first.map(r => [String(r.order_id), r.first_at])), r2 = new Set(resp.map(r => String(r.order_id)));
    for (const l of leads) { const k = String(l.id); if (f.has(k)) l.wa_first_at = f.get(k); if (r2.has(k)) l.wa_responded = true; }
  } catch (e) { console.error('[IVR] WhatsApp head start skipped:', e.message); }
}

// What the IVR already did for each open order: how many real calls, when the last one was, and whether the customer pressed a key.
async function ivrState(db, now = new Date()) {
  const rows = await db(`SELECT order_id, COUNT(*) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system'))::int AS tries, MAX(placed_at) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system')) AS last_at,
                                BOOL_OR(result IS NOT NULL) AS answered, BOOL_OR(status = 'skipped' AND placed_at > NOW() - INTERVAL '24 hours') AS skipped_recently,
                                COUNT(*) FILTER (WHERE status = 'failed' AND placed_at > NOW() - INTERVAL '24 hours')::int AS fails_recent,
                                COUNT(*) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system') AND placed_at >= $1)::int AS tries_today
                         FROM ivr_calls WHERE NOT is_test AND order_id IS NOT NULL GROUP BY order_id`, [ivr.istDayStart(now)]);
  return new Map(rows.map(r => [r.order_id, { tries: r.tries, tries_today: r.tries_today, last_at: r.last_at, answered: r.answered, skipped_recently: r.skipped_recently, fails_recent: r.fails_recent }]));
}

// Real calls placed since midnight India time (failed requests do not count, they never rang).
async function callsToday(db, now = new Date()) {
  const r = await db(`SELECT COUNT(*)::int AS n FROM ivr_calls WHERE NOT is_test AND status NOT IN ('failed', 'skipped', 'failed_system') AND placed_at >= $1`, [ivr.istDayStart(now)]);
  return r[0] ? r[0].n : 0;
}

// What the IVR provider needs for each lead, in calling order. A phone that appears on several open orders is marked so it is called once.
async function listRows(db, ids, groupById) {
  if (!ids.length) return [];
  const rows = await db(
    `SELECT o.id, o.order_name, o.customer_name, o.customer_phone, o.total_price, COALESCE(o.shopify_created_at, o.created_at) AS placed_at,
            CASE WHEN o.assigned_to = 'InHouse' THEN 'Aman' ELSE 'Call centre' END AS team,
            (SELECT COUNT(*)::int FROM lead_call_log g WHERE g.order_id = o.id AND g.disposition = 'dnp') AS dnp_tries
     FROM orders_master o WHERE o.id = ANY($1)`, [ids]);
  const byId = new Map(rows.map(r => [r.id, r]));
  const seen = new Map(), out = [];
  for (const id of ids) {
    const r = byId.get(id); if (!r) continue;
    const phone = r.customer_phone ? String(r.customer_phone).replace(/\D/g, '').slice(-10) : '';
    const dup = phone && seen.has(phone);
    if (phone && !dup) seen.set(phone, r.order_name);
    out.push({ ...r, phone, group: groupById[id] || '', same_phone_as: dup ? seen.get(phone) : '' });
  }
  return out;
}

// ---------------- stage 2: test calls and key presses ----------------
const calls = require('./ivrCalls');

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db(`CREATE TABLE IF NOT EXISTS ivr_calls (
    id BIGSERIAL PRIMARY KEY, order_id UUID, phone TEXT NOT NULL, is_test BOOLEAN NOT NULL DEFAULT FALSE, template TEXT, flow_id TEXT, call_id TEXT,
    attempt INT NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'placed', dtmf TEXT, result TEXT, applied BOOLEAN NOT NULL DEFAULT FALSE, note TEXT,
    placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), result_at TIMESTAMPTZ)`);
  await db(`ALTER TABLE ivr_calls ADD COLUMN IF NOT EXISTS kind TEXT`);   // fresh | retry | backlog
  try { await db(`CREATE UNIQUE INDEX IF NOT EXISTS ivr_calls_one_real_call_idx ON ivr_calls (order_id, attempt) WHERE NOT is_test AND order_id IS NOT NULL AND status NOT IN ('skipped', 'failed', 'failed_system')`); }
  catch (e) { console.error('[IVR] could not create the one-call-per-attempt index (duplicates already exist?):', e.message); }
  await db(`CREATE INDEX IF NOT EXISTS ivr_calls_call_id_idx ON ivr_calls (call_id)`);
  await db(`CREATE INDEX IF NOT EXISTS ivr_calls_phone_idx ON ivr_calls (phone, placed_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS ivr_calls_order_idx ON ivr_calls (order_id)`);
  await db(`CREATE TABLE IF NOT EXISTS ivr_keypress_log (id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), params JSONB, call_row BIGINT, outcome TEXT)`);
  await db(`CREATE TABLE IF NOT EXISTS ivr_flags (name TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  tablesReady = true;
}

// Emergency stop that works at once, without changing anything in Railway.
async function isPaused(db) { const r = await db(`SELECT value FROM ivr_flags WHERE name = 'paused'`); return !!(r[0] && r[0].value === '1'); }
async function setPaused(db, paused) {
  await ensureTables(db);
  await db(`INSERT INTO ivr_flags (name, value) VALUES ('paused', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [paused ? '1' : '0']);
  return paused;
}

// A confirm from the IVR changes an order only if it is still pending (a person may have confirmed or cancelled it meanwhile). One history line, actor ivr_call.
async function applyConfirm(db, row) {
  const upd = await db(`UPDATE orders_master SET confirmation_status = 'confirmed', confirmed_at = NOW(), call_attempts = call_attempts + 1, last_call_at = NOW()
                        WHERE id = $1 AND confirmation_status = 'pending' RETURNING id`, [row.order_id]);
  if (!upd.length) { await db(`UPDATE ivr_calls SET note = 'Order was no longer pending, nothing changed' WHERE id = $1`, [row.id]); return 'order_not_pending'; }
  await db(`SELECT log_status_change($1, 'confirmed', 'pending', 'confirmed', 'ivr_call', $2)`, [row.order_id, 'via IVR call ' + (row.call_id || row.id)]);
  await db(`UPDATE ivr_calls SET applied = TRUE WHERE id = $1`, [row.id]);
  return 'confirmed_order';
}

// Key 2 (change the address) and key 3 (cancel) never change the order by themselves: a person calls back first. The order gets a callback due now
// with a note saying what the customer pressed, and one history line. The IVR's hold on the lead ends at once, so the callers see it straight away (a customer who asked to cancel must not wait for the hold to run out).
const FOLLOW = { address_change: 'IVR: customer pressed 2, wants to change the delivery address. Please call back.', cancel_requested: 'IVR: customer pressed 3 (cancel). Please call and try to save the order. Cancel it only if the customer says so on the call.' };
async function followUp(db, row, result) {
  const upd = await db(`UPDATE orders_master SET callback_at = NOW(), callback_note = $2, updated_at = NOW(), lead_locked_by = CASE WHEN lead_locked_by = 'IVR' THEN NULL ELSE lead_locked_by END,
                        lead_locked_at = CASE WHEN lead_locked_by = 'IVR' THEN NULL ELSE lead_locked_at END WHERE id = $1 AND confirmation_status = 'pending' RETURNING id`, [row.order_id, FOLLOW[result]]);
  if (!upd.length) return 'order_not_pending';
  await db(`SELECT log_status_change($1, 'ivr_followup', NULL, $2, 'ivr_call', $3)`, [row.order_id, result, FOLLOW[result]]);
  return 'followup_set';
}

// The IVR flow calls our address with the key the customer pressed. Match it to the call we placed (by call id, else by phone and the last 3 hours), save it once.
async function recordKeypress(db, params, now = new Date()) {
  await ensureTables(db);
  const callId = calls.pickCallId(params), phone = calls.pickPhone(params), result = calls.mapKey(params.dtmf);
  let row = null;
  if (callId) row = (await db(`SELECT * FROM ivr_calls WHERE call_id = $1 ORDER BY id DESC LIMIT 1`, [callId]))[0] || null;
  if (!row && phone) row = (await db(`SELECT * FROM ivr_calls WHERE phone = $1 AND result IS NULL AND placed_at > $2 ORDER BY id DESC LIMIT 1`, [phone, new Date(new Date(now).getTime() - 3 * 3600e3)]))[0] || null;
  let outcome;
  if (!row) outcome = 'unmatched';
  else if (row.result) outcome = 'duplicate';
  else {
    const claimed = await db(`UPDATE ivr_calls SET dtmf = $2, result = $3, result_at = NOW(), status = 'answered' WHERE id = $1 AND result IS NULL RETURNING id`, [row.id, String(params.dtmf == null ? '' : params.dtmf).slice(0, 5), result]);
    if (!claimed.length) outcome = 'duplicate';
    else if (row.order_id && !row.is_test) {
      outcome = result === 'confirmed' ? await applyConfirm(db, row) : (result === 'address_change' || result === 'cancel_requested') ? await followUp(db, row, result) : 'recorded';
      await db(`UPDATE orders_master SET lead_locked_by = NULL, lead_locked_at = NULL WHERE id = $1 AND lead_locked_by = 'IVR'`, [row.order_id]);   // the customer answered: the lead is free again
    } else outcome = row.is_test ? 'test_recorded' : 'recorded';
  }
  await db(`INSERT INTO ivr_keypress_log (params, call_row, outcome) VALUES ($1, $2, $3)`, [JSON.stringify(calls.withoutSecret(params)), row ? row.id : null, outcome]);
  return { outcome, result, matched: !!row, order_id: row ? row.order_id : null };
}

// A test call to one of the owner's own numbers (IVR_TEST_NUMBERS). Never touches an order. At most 10 per hour.
async function placeTestCall(db, slot, { env = process.env, http, now = new Date() } = {}) {
  await ensureTables(db);
  const s = calls.settings(env), phone = s.testNumbers[Number(slot)];
  if (!phone) return { ok: false, message: 'That test number is not set up' };
  const recent = await db(`SELECT COUNT(*)::int AS n FROM ivr_calls WHERE is_test AND placed_at > $1`, [new Date(new Date(now).getTime() - 3600e3)]);
  if (recent[0] && recent[0].n >= 10) return { ok: false, message: 'Too many test calls in the last hour. Please wait.' };
  const ins = await db(`INSERT INTO ivr_calls (phone, is_test, template, flow_id) VALUES ($1, TRUE, $2, $3) RETURNING id`, [phone, s.template, String(s.flowId)]);
  const id = ins[0].id;
  const r = await calls.dialByText({ phone, name: 'Test', amount: '599', orderId: 'TEST' + id, settings: s, http });
  await db(`UPDATE ivr_calls SET call_id = $2, status = $3, note = $4 WHERE id = $1`, [id, r.callId || null, r.ok ? 'placed' : 'failed', r.message]);
  return { ok: r.ok, message: r.message, id };
}

async function recentCalls(db, n = 60) {
  await ensureTables(db);
  return db(`SELECT c.id, c.phone, c.is_test, c.status, c.dtmf, c.result, c.applied, c.note, c.kind, c.attempt, c.placed_at, c.result_at, o.order_name
             FROM ivr_calls c LEFT JOIN orders_master o ON o.id = c.order_id ORDER BY c.id DESC LIMIT $1`, [n]);
}

// Today's real IVR calls in numbers (India time).
async function todayStats(db, now = new Date()) {
  await ensureTables(db);
  const r = await db(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system'))::int AS placed, COUNT(*) FILTER (WHERE status IN ('failed', 'failed_system'))::int AS failed, COUNT(*) FILTER (WHERE status = 'skipped')::int AS left_to_person,
                             COUNT(*) FILTER (WHERE result = 'confirmed')::int AS k1, COUNT(*) FILTER (WHERE result = 'address_change')::int AS k2,
                             COUNT(*) FILTER (WHERE result = 'cancel_requested')::int AS k3
                      FROM ivr_calls WHERE NOT is_test AND placed_at >= $1`, [ivr.istDayStart(now)]);
  const x = r[0] || { placed: 0, failed: 0, left_to_person: 0, k1: 0, k2: 0, k3: 0 };
  return { ...x, no_key: Math.max(0, x.placed - x.k1 - x.k2 - x.k3), paused: await isPaused(db) };
}

// Is this order fine for the IVR to call? Returns Map(id -> null | reason). A reason means "leave it to a person": a phone that is not a valid mobile number, an address a courier
// cannot use, or a risk level above IVR_MAX_RISK (the CRM's own score: RTO history of the pincode, earlier refusals, repeat orders, order value).
// The risk score's "invalid phone" rule reads the raw stored text, so a number stored with +91 or spaces is wrongly penalised: those points are taken back when the
// last ten digits are a valid mobile number, and the level is read again.
async function screenOrders(db, rows, s) {
  const out = new Map();
  if (!rows.length) return out;
  const rc = require('./riskConfig'), toLevel = (pts) => (pts >= rc.levels.high ? 'High' : pts >= rc.levels.medium ? 'Medium' : 'Low');
  const okLevels = s.maxRisk === 'medium' ? ['Low', 'Medium'] : ['Low'];
  const scored = await require('./risk').attachRisk(db, rows);
  for (const r of scored) {
    const d = calls.tenDigits(r.customer_phone);
    if (d.length !== 10) { out.set(r.id, 'bad_phone'); continue; }
    const bad = ivr.addressProblem(r); if (bad) { out.set(r.id, bad); continue; }
    let pts = Number(r.risk_points) || 0;
    if ((r.risk_reasons || []).includes('Phone number looks invalid') && /^[6-9]\d{9}$/.test(d)) pts -= rc.phone.invalidPoints;
    const lvl = toLevel(pts);
    out.set(r.id, okLevels.includes(lvl) ? null : 'risk_' + lvl.toLowerCase());
  }
  return out;
}
// "Start now": run the no-answer calls at once for a while, outside the best hours but inside the day hours (9 AM to 9 PM).
async function forcedNow(db, now, s) {
  const hour = new Date(new Date(now).getTime() + 19800000).getUTCHours();
  const h = require('./hourCurve').settings();
  if (hour < h.from || hour >= h.to) return false;
  const r = await db(`SELECT value FROM ivr_flags WHERE name = 'force_until'`);
  return !!(r[0] && new Date(r[0].value) > new Date(now));
}
async function setForce(db, minutes, now = new Date()) {
  await ensureTables(db);
  const m = Math.max(0, Math.min(720, Math.floor(Number(minutes) || 0)));
  if (!m) { await db(`DELETE FROM ivr_flags WHERE name = 'force_until'`); return null; }
  const until = new Date(new Date(now).getTime() + m * 60000);
  await db(`INSERT INTO ivr_flags (name, value) VALUES ('force_until', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [until.toISOString()]);
  return until;
}
async function forceUntil(db) { await ensureTables(db); const r = await db(`SELECT value FROM ivr_flags WHERE name = 'force_until'`); return r[0] && new Date(r[0].value) > new Date() ? new Date(r[0].value) : null; }
// The hour-by-hour pick-up curve is learned from 30 days of calls: re-read at most every 30 minutes. If it cannot be read, the smart hours stay closed (only the fixed windows run).
let curveCache = { at: 0, curve: null };
async function smartNow(db, now, s) {
  if (!s.smart) return { open: false };
  try {
    if (!curveCache.curve || new Date(now).getTime() - curveCache.at > 30 * 60000) curveCache = { at: new Date(now).getTime(), curve: await hourData(db) };
    return require('./hourCurve').smartNow(curveCache.curve, now);
  } catch (e) { console.error('[IVR] could not read the pick-up curve:', e.message); return { open: false }; }
}

// One minute of IVR work (the worker runs this every minute). Acts only when IVR_MODE=on, the window is open, nothing is paused and the set-up is complete.
// Priority: FRESH orders (never called) go first, oldest waiting first, so every new order is called within minutes; retries and the old backlog follow and may use
// only part of the daily cap. Before each call the order is checked: a phone number that looks valid, a deliverable address, and a LOW risk score (RTO history of the
// pincode, earlier refusals, repeat orders, order value). Anything else is left to a person and is never auto-confirmed. Each called lead is locked for the people.
// COVER DAY (automatic, owner rule 2026-11-22): when NOBODY from Aman or the call centre has opened the CRM or logged a call for 30 minutes, between 9:30 AM and 6 PM, the IVR covers the day:
// the fixed window opens from 9 AM (so new orders are called at once), and the daily cap rises to IVR_COVER_CAP (default 500). The moment a caller is back the next minute runs with the normal rules.
// Switch it off with IVR_COVER=off. A failed check means "not a cover day": the normal rules stay.
async function coverMode(db, now, env = process.env) {
  if (String(env.IVR_COVER || 'on').trim().toLowerCase() === 'off') return false;
  const t = new Date(new Date(now).getTime() + 19800000), hr = t.getUTCHours() + t.getUTCMinutes() / 60;
  if (hr < 9.5 || hr >= 18) return false;
  try {
    const r = await db(`SELECT (SELECT COUNT(*) FROM agent_presence p JOIN agents a ON a.id = p.agent_id WHERE a.is_active = TRUE AND a.role IN ('agent', 'aman') AND p.last_seen_at > NOW() - INTERVAL '30 minutes')::int AS seen,
                               (SELECT COUNT(*) FROM lead_call_log g JOIN agents a ON a.id = g.agent_id WHERE a.role IN ('agent', 'aman') AND g.created_at > NOW() - INTERVAL '30 minutes')::int AS calls`);
    return !!r[0] && Number(r[0].seen) === 0 && Number(r[0].calls) === 0;
  } catch (e) { console.error('[IVR] cover check failed:', e.message); return false; }
}
function coverEnv(env) {
  const cap = Number(env.IVR_COVER_CAP) > 0 ? Number(env.IVR_COVER_CAP) : 500;
  return { ...env, IVR_MORNING_START: '9', IVR_MORNING_END: '18', IVR_DAILY_CAP: String(Math.max(ivr.settings(env).dailyCap, cap)) };
}
async function tick(db, { now = new Date(), env: envIn = process.env, http } = {}) {
  let env = envIn, s = ivr.settings(env);
  const c = calls.settings(env);
  if (s.mode !== 'on') return { skipped: 'mode_' + s.mode };
  await ensureTables(db);
  if (await isPaused(db)) return { skipped: 'paused' };
  const cover = await coverMode(db, now, env);
if (cover) { env = coverEnv(env); s = ivr.settings(env); }
  // Three kinds of calls, each with its own open time and its own share of the day's cap, so one early burst can never use up the day:
  //   NEW orders nobody has called (placed in the last 18 hours): only in the fixed window (6 PM to 11 PM), at most IVR_FRESH_SHARE of the cap. Callers get them first in the day.
  //   FIRST CALL on an OLDER lead nobody has called yet: OFF by default (IVR_FIRST_SHARE=0). From 9 AM to 6 PM the agents own every fresh lead; this is only an option for the owner.
  //   NO-ANSWER leads (retries): only in the best hours chosen from your call data, at most IVR_NON_FRESH_SHARE of the cap, spread over those hours.
  const fixedOpen = ivr.windowStatus(now, s).open;
  let smart = await smartNow(db, now, s);
  // The admin can start the no-answer calls at once for a while (the Start now button): that skips the choice of best hours, never the day hours (9 AM to 9 PM) or the caps.
  if (!smart.open && await forcedNow(db, now, s)) smart = { open: true, share: 1, forced: true, hour: new Date(new Date(now).getTime() + 19800000).getUTCHours() };
  const hc = require('./hourCurve').settings(env), hourNow = new Date(new Date(now).getTime() + 19800000).getUTCHours();
  const dayOpen = hourNow >= hc.from && hourNow < hc.to;                                   // 9 AM to 9 PM: the day hours, when first calls on older leads may go out
  if (!fixedOpen && !smart.open && !dayOpen) return { skipped: 'window_closed' };
  const miss = calls.missing(c).filter(n => n !== 'IVR_TEST_NUMBERS');
  if (miss.length) return { skipped: 'not_set_up', missing: miss };
  const { plan: p, usedToday } = await plan(db, now, env, { cover, envReady: true });
  const room = Math.max(0, s.dailyCap - usedToday);
  const out = { placed: 0, failed: 0, skipped: {}, cap_left: room }; if (smart.forced) out.forced = true; if (cover) out.cover = true;
  // Outside the fixed window and the best hours only first calls may go out; when there is none to place, say plainly that the window is closed.
  const idle = () => (!fixedOpen && !smart.open ? { skipped: 'window_closed' } : out);
  if (!room || !p.ids.length) return idle();
  const nf = await db(`SELECT COUNT(*) FILTER (WHERE COALESCE(kind, '') NOT IN ('fresh', 'first'))::int AS n, COUNT(*) FILTER (WHERE COALESCE(kind, '') = 'fresh')::int AS fresh, COUNT(*) FILTER (WHERE COALESCE(kind, '') = 'first')::int AS first FROM ivr_calls WHERE NOT is_test AND status NOT IN ('failed', 'skipped', 'failed_system') AND placed_at >= $1`, [ivr.istDayStart(now)]);
  let nonFreshRoom = Math.max(0, Math.floor(s.dailyCap * s.nonFreshShare) - (nf[0] ? nf[0].n : 0));
  let freshRoom = Math.max(0, Math.floor(s.dailyCap * s.freshShare) - (nf[0] ? (nf[0].fresh || 0) : 0));
  let firstRoom = Math.max(0, Math.floor(s.dailyCap * s.firstShare) - (nf[0] ? (nf[0].first || 0) : 0));
  const kinds = p.kindById || {}, groups = p.groupById || {}, window = [], role = {};
  for (const id of p.ids) {
    const k = kinds[id] || 'backlog';
    if (k === 'fresh') { if (!fixedOpen || freshRoom <= 0) continue; freshRoom--; role[id] = 'fresh'; }          // new orders: only in the fixed window, within their share of the day
    else if (k !== 'retry' && /\/never$/.test(String(groups[id] || ''))) { if (!(dayOpen || fixedOpen) || firstRoom <= 0) continue; firstRoom--; role[id] = 'first'; }   // older lead, no attempt by anyone: first call at the first day hour
    else { if (!smart.open || nonFreshRoom <= 0) continue; nonFreshRoom--; role[id] = k; }                       // no-answer leads: only in a best hour, within their share of the day
    window.push(id); if (window.length >= s.perRun * 5) break;
  }
  // In a smart hour the no-answer calls are paced: a better hour gets a bigger share of the day's no-answer budget, so the whole budget is not spent in the first hour.
  let hourRoom = Infinity;
  if (smart.open && !smart.forced) {
    const ist = new Date(now).getTime() + 19800000, hourStart = new Date(Math.floor(ist / 3600000) * 3600000 - 19800000), hourEnd = new Date(hourStart.getTime() + 3600000);
    const used = await db(`SELECT COUNT(*)::int AS n FROM ivr_calls WHERE NOT is_test AND status NOT IN ('failed', 'skipped', 'failed_system') AND COALESCE(kind, '') NOT IN ('fresh', 'first') AND placed_at >= $1 AND placed_at < $2`, [hourStart, hourEnd]);
    hourRoom = Math.max(0, Math.max(1, Math.ceil(Math.floor(s.dailyCap * s.nonFreshShare) * smart.share)) - (used[0] ? used[0].n : 0));
    out.smart_hour = { hour: smart.hour, share: Math.round(smart.share * 100) / 100, room: hourRoom };
  }
  if (!window.length) return idle();
  const rows = await db(`SELECT id, order_name, customer_name, customer_phone, total_price, shipping_address1, shipping_address2, shipping_city, shipping_province, shipping_zip, lead_locked_by, lead_locked_at
                         FROM orders_master WHERE id = ANY($1) AND confirmation_status = 'pending'`, [window]);
  const verdict = await screenOrders(db, rows, s);   // id -> null (fine to call) or the reason it is left to a person
  const byId = new Map(rows.map(r => [r.id, r]));
  const recentPhones = new Set((await db(`SELECT phone FROM ivr_calls WHERE NOT is_test AND status NOT IN ('failed', 'skipped', 'failed_system') AND placed_at > $1`, [new Date(new Date(now).getTime() - s.gapMinutes * 60000)])).map(r => r.phone));
  const bump = (k) => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const leave = async (id, phone, why, kind) => { bump(why); await db(`INSERT INTO ivr_calls (order_id, phone, is_test, status, note, kind) VALUES ($1, $2, FALSE, 'skipped', $3, $4)`, [id, phone || '', 'Left to a person: ' + why, kind]); };
  const limit = Math.min(room, s.perRun);
  let streak = 0, nfPlaced = 0; const streakIds = [];
  for (const id of window) {
    if (out.placed >= limit) break;
    const o = byId.get(id); if (!o) { bump('not_pending'); continue; }
    const kind = role[id] || kinds[id] || 'backlog', phone = calls.tenDigits(o.customer_phone);
    if (kind !== 'fresh' && kind !== 'first' && nfPlaced >= hourRoom) { bump('hour_budget_used'); continue; }   // this best hour already had its share of no-answer calls
    const why = verdict.get(id); if (why) { await leave(id, phone, why, kind); continue; }
    if (recentPhones.has(phone)) { bump('same_phone_called'); continue; }
    recentPhones.add(phone);
    // ONE OWNER PER LEAD: the IVR claims the lead BEFORE it dials, in one atomic step. If a person (Aman or the call centre) has opened it or locked it in the last 15 minutes, the claim fails and the IVR does not call.
    // From this moment the lead is the IVR's: it is hidden from both caller lists until the hold ends or the customer answers. GREATEST keeps a longer hold (see holdBacklog).
    const wasHeld = o.lead_locked_by === 'IVR' && o.lead_locked_at && new Date(o.lead_locked_at).getTime() > new Date(now).getTime() - 15 * 60000;
    const claim = await db(`UPDATE orders_master SET lead_locked_by = 'IVR', lead_locked_at = GREATEST(COALESCE(lead_locked_at, NOW()), NOW() + ($2 || ' minutes')::interval)
                            WHERE id = $1 AND confirmation_status = 'pending' AND (lead_locked_by IS NULL OR lead_locked_by = 'IVR' OR lead_locked_at < NOW() - INTERVAL '15 minutes') RETURNING id`, [id, String(s.lockMinutes)]);
    if (!claim.length) { bump('person_has_it'); continue; }
    const att = await db(`SELECT COUNT(*)::int AS n FROM ivr_calls WHERE order_id = $1 AND NOT is_test AND status NOT IN ('failed', 'skipped', 'failed_system')`, [id]);
    // The unique index (one real call per order and attempt number) makes a second worker, or a repeat of the same minute, fail here instead of calling the customer twice.
    let ins;
    try { ins = await db(`INSERT INTO ivr_calls (order_id, phone, is_test, template, flow_id, attempt, kind) VALUES ($1, $2, FALSE, $3, $4, $5, $6) RETURNING id`, [id, phone, c.template, String(c.flowId), (att[0] ? att[0].n : 0) + 1, kind]); }
    catch (e) { if (e && e.code === '23505') { bump('already_being_called'); continue; } throw e; }
    const r = await calls.dialByText({ phone, name: o.customer_name, amount: Math.round(Number(o.total_price) || 0), orderId: String(o.order_name || '').replace(/\D/g, ''), settings: c, http });
    await db(`UPDATE ivr_calls SET call_id = $2, status = $3, note = $4 WHERE id = $1`, [ins[0].id, r.callId || null, r.ok ? 'placed' : 'failed', r.message]);
    if (r.ok) {
      out.placed++; if (kind !== 'fresh' && kind !== 'first') nfPlaced++; streak = 0; streakIds.length = 0;   // the lead was claimed above, before the call
    } else {
      out.failed++; streakIds.push(ins[0].id);
      if (!wasHeld) await db(`UPDATE orders_master SET lead_locked_by = NULL, lead_locked_at = NULL WHERE id = $1 AND lead_locked_by = 'IVR'`, [id]);   // the call never went out: give the lead back to the callers
      // Three requests in a row refused means the IVR service (or the wallet, or a setting) is the problem, not these three orders: stop for this minute and do not
      // count those requests against the orders. A single refusal is a problem with that order (for example its number), and two of those leave it to a person.
      if (++streak >= 3) { out.stopped = 'three_failures_in_a_row'; out.last_error = r.message; await db(`UPDATE ivr_calls SET status = 'failed_system' WHERE id = ANY($1)`, [streakIds]); break; }
    }
  }
  return out;
}
// The worker runs tick() every minute. Its last result is saved so the CRM can show whether the worker is running and, if it placed nothing, why
// (for example IVR_MODE is not on in the worker, a setting is missing there, or the window is closed).
async function runAndRecord(db, opts) {
  try { await ensureTables(db); await releaseFinished(db, (opts && opts.env) || process.env); } catch (e) { console.error('[IVR] could not release finished leads:', e.message); }
  let ah = null; try { ah = await autoHold(db, opts); } catch (e) { console.error('[IVR] automatic hold failed:', e.message); }
  const r = await tick(db, opts); if (ah) r.auto_hold = ah;
  { const se = ivr.settings((opts && opts.env) || process.env); r.worker = { mode: se.mode, cap: se.dailyCap, smart: se.smart, per_day: se.triesPerDay }; }   // what the WORKER reads, so the page can show it next to what the web service reads
  try { await ensureTables(db); await db(`INSERT INTO ivr_flags (name, value) VALUES ('last_tick', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(r)]); } catch (e) { console.error('[IVR] could not save the last run:', e.message); }
  return r;
}
async function lastTick(db) {
  await ensureTables(db);
  const r = await db(`SELECT value, updated_at FROM ivr_flags WHERE name = 'last_tick'`);
  if (!r[0]) return null;
  let v = {}; try { v = JSON.parse(r[0].value); } catch (e) { /* keep empty */ }
  try { const a = await db(`SELECT value, updated_at FROM ivr_flags WHERE name = 'last_auto_hold'`); if (a[0]) v.auto_hold = { ...JSON.parse(a[0].value), at: a[0].updated_at }; } catch (e) { /* no automatic hold yet */ }
  return { at: r[0].updated_at, reason: typeof v.skipped === 'string' ? v.skipped : null, missing: v.missing || null, placed: v.placed || 0, failed: v.failed || 0,
    lead_skips: v.skipped && typeof v.skipped === 'object' ? v.skipped : {}, stopped: v.stopped || null, last_error: v.last_error || null, auto_hold: v.auto_hold || null, worker: v.worker || null, forced: !!v.forced, cover: !!v.cover, cap_left: v.cap_left == null ? null : v.cap_left };
}

// ---------------- old no-answer leads: hold them for the IVR so the callers do not see them ----------------
// "Hold" = lock the lead as 'IVR' for some hours. The people's queues already hide locked leads, and the lock clears by itself when the hours are over, so a hold can never
// hide a lead for good. Only leads the IVR can really call are held (valid phone, deliverable address, low risk); everything else stays with the callers.
async function holdBacklog(db, { count = 300, hours = 48, now = new Date(), env = process.env } = {}) {
  await ensureTables(db);
  const s = ivr.settings(env);
  count = Math.max(0, Math.min(2000, Math.floor(Number(count) || 0))); hours = Math.max(1, Math.min(168, Math.floor(Number(hours) || 48)));
  const { plan: p } = await plan(db, now, env);
  const ids = (p.all_ids || []).filter(id => (p.all_kind[id] || 'backlog') !== 'fresh');       // new orders keep their normal flow
  const out = { candidates: ids.length, held: 0, not_free: 0, left_to_person: {}, hours };
  const pos = new Map(ids.map((id, i) => [id, i])), okIds = [];
  for (let i = 0; i < ids.length && okIds.length < count; i += 300) {
    const rows = await db(`SELECT id, customer_phone, total_price, shipping_address1, shipping_address2, shipping_city, shipping_province, shipping_zip, lead_locked_by, lead_locked_at
                           FROM orders_master WHERE id = ANY($1) AND confirmation_status = 'pending'`, [ids.slice(i, i + 300)]);
    rows.sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const verdict = await screenOrders(db, rows, s);
    for (const r of rows) { if (r.lead_locked_by === 'IVR' && r.lead_locked_at && new Date(r.lead_locked_at) > new Date(new Date(now).getTime() - 15 * 60000)) { out.already_held = (out.already_held || 0) + 1; continue; } const why = verdict.get(r.id); if (why) out.left_to_person[why] = (out.left_to_person[why] || 0) + 1; else if (okIds.length < count) okIds.push(r.id); }
  }
  if (okIds.length) {
    const r = await db(`UPDATE orders_master SET lead_locked_by = 'IVR', lead_locked_at = NOW() + ($2 || ' minutes')::interval
                        WHERE id = ANY($1) AND confirmation_status = 'pending' AND (lead_locked_by IS NULL OR lead_locked_at < NOW() - INTERVAL '15 minutes' OR lead_locked_by = 'IVR') RETURNING id`, [okIds, String(hours * 60 - 15)]);
    out.held = r.length; out.not_free = okIds.length - r.length;
  }
  return out;
}

// Automatic hold: with IVR_AUTO_HOLD=300 the worker keeps about 300 old no-answer leads on hold for the IVR. It tops up once in the hour before each window (5 AM and 5 PM India time),
// never while paused, and a hold always ends by itself (IVR_AUTO_HOLD_HOURS, default 30, so a lead stays hidden until its next daily try). Leave IVR_AUTO_HOLD empty or 0 to switch it off.
async function autoHold(db, { now = new Date(), env = process.env } = {}) {
  const n = Math.max(0, Math.min(2000, Math.floor(Number(env.IVR_AUTO_HOLD) || 0)));
  if (!n || ivr.settings(env).mode !== 'on') return null;
  const hour = new Date(new Date(now).getTime() + 5.5 * 3600e3).getUTCHours();
  if (hour !== 5 && hour !== 17) return null;
  await ensureTables(db);
  if (await isPaused(db)) return null;
  const slot = 'auto_hold_' + ivr.istDayStart(now).toISOString().slice(0, 10) + '_' + hour;
  const claimed = await db(`INSERT INTO ivr_flags (name, value) VALUES ($1, '1') ON CONFLICT (name) DO NOTHING RETURNING name`, [slot]);
  if (!claimed.length) return null;                                  // already done in this hour
  const need = n - await heldCount(db);
  let res;
  if (need <= 0) res = { wanted: n, held: 0, already: n };
  else { const r = await holdBacklog(db, { count: need, hours: Number(env.IVR_AUTO_HOLD_HOURS) || 30, now, env }); res = { wanted: n, held: r.held, candidates: r.candidates, left_to_person: r.left_to_person, hours: r.hours }; }
  await db(`INSERT INTO ivr_flags (name, value) VALUES ('last_auto_hold', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(res)]);
  return res;
}
// Give leads back to the callers when the IVR is finished with them: confirmed or cancelled meanwhile, all its tries used (and the last one is 2 hours old),
// refused twice by the IVR service, or left to a person.
async function releaseFinished(db, env = process.env) {
  const s = ivr.settings(env);
  const r = await db(`UPDATE orders_master o SET lead_locked_by = NULL, lead_locked_at = NULL
    WHERE o.lead_locked_by = 'IVR' AND (o.confirmation_status <> 'pending' OR EXISTS (
      SELECT 1 FROM ivr_calls c WHERE c.order_id = o.id AND NOT c.is_test GROUP BY c.order_id
      HAVING (COUNT(*) FILTER (WHERE c.status NOT IN ('failed', 'skipped', 'failed_system')) >= $1
              AND MAX(c.placed_at) FILTER (WHERE c.status NOT IN ('failed', 'skipped', 'failed_system')) < NOW() - INTERVAL '2 hours')
          OR COUNT(*) FILTER (WHERE c.status = 'failed' AND c.placed_at > NOW() - INTERVAL '24 hours') >= 2
          OR BOOL_OR(c.status = 'skipped' AND c.placed_at > NOW() - INTERVAL '24 hours'))) RETURNING o.id`, [s.maxTries]);
  return r.length;
}
async function releaseAll(db) { const r = await db(`UPDATE orders_master SET lead_locked_by = NULL, lead_locked_at = NULL WHERE lead_locked_by = 'IVR' RETURNING id`); return r.length; }
async function heldCount(db) { const r = await db(`SELECT COUNT(*)::int AS n FROM orders_master WHERE lead_locked_by = 'IVR' AND lead_locked_at > NOW() - INTERVAL '15 minutes'`); return r[0] ? r[0].n : 0; }
// Calls by hour of day (India time) for the last 30 days: the callers' real calls on COD orders (all calls, and the retry calls) and the IVR's own real calls.
async function hourData(db) {
  await ensureTables(db);
  const cfg = require('./config');
  // A "retry" is a call on an order whose previous call was a no-answer AND came at least an hour earlier. Quick re-dials inside the hour (often a wrongly marked no-answer) and
  // scheduled callbacks are not retries: counting them made 9-10 AM look far better than it is (checked on the 1-17 Nov call log: those calls connect 78% of the time, true retries 29%).
  const humanSql = (retryTest, extra) => `SELECT hour, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE conn)::int AS connected, COUNT(*) FILTER (WHERE is_retry)::int AS retry_calls, COUNT(*) FILTER (WHERE is_retry AND conn)::int AS retry_connected
    FROM (SELECT EXTRACT(HOUR FROM g.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, (g.disposition = ANY($2)) AS conn, ${retryTest} AS is_retry
          FROM lead_call_log g JOIN orders_master o ON o.id = g.order_id
          WHERE g.created_at >= NOW() - INTERVAL '30 days' AND g.disposition = ANY($1) AND UPPER(COALESCE(o.payment_method, '')) = 'COD'${extra}) x
    GROUP BY hour ORDER BY hour`;
  const params = [cfg.CALL_DISPOSITIONS, cfg.CONNECTED_DISPOSITIONS];
  let human;
  try { human = await db(humanSql(`(LAG(g.disposition) OVER w = 'dnp' AND g.created_at - LAG(g.created_at) OVER w >= INTERVAL '1 hour')`, ` WINDOW w AS (PARTITION BY g.order_id ORDER BY g.created_at)`), params); }
  catch (e) { console.error('[IVR] hour query fell back to the simple retry rule:', e.message); human = await db(humanSql(`(ROW_NUMBER() OVER (PARTITION BY g.order_id ORDER BY g.created_at) >= 2)`, ''), params); }
  const ivrRows = await db(`SELECT EXTRACT(HOUR FROM placed_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system'))::int AS placed, COUNT(*) FILTER (WHERE result IS NOT NULL)::int AS pressed
    FROM ivr_calls WHERE NOT is_test AND placed_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`);
  return require('./hourCurve').build({ human, ivr: ivrRows });
}
// IVR performance by day (India time) for the admin Home: real calls only, never test calls.
async function report(db, start, end) {
  await ensureTables(db);
  const rows = await db(`SELECT (placed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
      COUNT(DISTINCT order_id) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system'))::int AS orders_called,
      COUNT(*) FILTER (WHERE status NOT IN ('failed', 'skipped', 'failed_system'))::int AS placed,
      COUNT(*) FILTER (WHERE result = 'confirmed')::int AS k1, COUNT(*) FILTER (WHERE result = 'address_change')::int AS k2, COUNT(*) FILTER (WHERE result = 'cancel_requested')::int AS k3,
      COUNT(*) FILTER (WHERE applied)::int AS confirmed_applied, COUNT(*) FILTER (WHERE status = 'skipped')::int AS left_to_person,
      COUNT(*) FILTER (WHERE status IN ('failed', 'failed_system'))::int AS failed
    FROM ivr_calls WHERE NOT is_test AND placed_at >= $1 AND placed_at < $2 GROUP BY 1 ORDER BY 1`, [start, end]);
  return require('./ivrReport').summarise(rows);
}

// The latest key presses the IVR sent us: when, what happened to each, and the NAMES of the details it sent (not the values), so we can see how a press is matched to a call.
async function recentKeypresses(db, n = 10) {
  await ensureTables(db);
  const rows = await db(`SELECT received_at, outcome, params FROM ivr_keypress_log ORDER BY id DESC LIMIT $1`, [n]);
  return rows.map(r => { const p = r.params || {}; return { at: r.received_at, outcome: r.outcome, key: p.dtmf == null ? '' : String(p.dtmf), fields: Object.keys(p).filter(k => k !== 'dtmf') }; });
}

const mask = (p) => String(p).slice(0, 2) + '•••••' + String(p).slice(-3);
function setup(env = process.env) {
  const s = calls.settings(env);
  return { missing: calls.missing(s), template: s.template, flow_id: s.flowId || null, did_set: !!s.did, test_numbers: s.testNumbers.map(mask) };
}

module.exports = { addWhatsApp, plan, listRows, ensureTables, recordKeypress, placeTestCall, recentCalls, setup, applyConfirm, mask, tick, todayStats, isPaused, setPaused, callsToday, ivrState, recentKeypresses, runAndRecord, lastTick, report, screenOrders, holdBacklog, releaseFinished, releaseAll, heldCount, autoHold, hourData, setForce, forceUntil, forcedNow, _resetCurve: () => { curveCache = { at: 0, curve: null }; } };
