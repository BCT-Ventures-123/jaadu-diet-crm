// The IVR provider's OWN record of our calls (owner 2026-11-27: "pull the call log into the CRM").
// Why: when the CRM asks IVR Solutions to place a call, the only thing that comes back later is the key the customer pressed. "No key pressed" could mean not picked up, picked up and no key, or never dialled.
// The provider keeps a log of every call (answered / missed, seconds, key). This module reads it (read-only API, POST /v1/all_call_logs, the "dialer_logs" stream, which also holds calls placed through the API under "Unknown Campaign"),
// stores it in ivr_provider_calls, and matches each provider call to our own ivr_calls row (same phone, close in time). Nothing here places or changes a call.
// Switched on with IVR_PROVIDER_SYNC=on (default off until the real field names were checked with the sample endpoint). The API key is read from IVR_API_KEY and never logged.
const BASE = 'https://api.ivrsolutions.in';
const tenDigits = (p) => String(p == null ? '' : p).replace(/\D/g, '').slice(-10);

function settings(env = process.env) {
  const raw = String(env.IVR_PROVIDER_SYNC || 'off').trim().replace(/^["']|["']$/g, '').toLowerCase();
  return { on: ['on', 'true', '1', 'yes'].includes(raw), apiKey: env.IVR_API_KEY || '' };
}

// One field out of a record, whichever name the provider used.
const pick = (o, names) => { for (const n of names) { const k = Object.keys(o || {}).find(x => x.toLowerCase() === n); if (k && o[k] !== null && o[k] !== undefined && String(o[k]).trim() !== '') return o[k]; } return ''; };

// "2026-11-27 08:54:12" is India time.
function parseTime(v) {
  const s = String(v || '').trim(); if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`) : new Date(s);
  return isNaN(d) ? null : d;
}

// answered / missed / unknown, from the provider's status words and the seconds the customer was on the line.
function classify(status, seconds) {
  const s = String(status || '').toLowerCase().replace(/[_\s-]+/g, '');
  if (/miss|noanswer|unanswer|busy|fail|reject|notreach|unreach|switchoff|congest|cancel/.test(s)) return 'missed';
  if (/answer|attend|connect|complete|picked/.test(s)) return 'answered';
  return Number(seconds) > 0 ? 'answered' : 'unknown';
}

// One provider record -> the fields we keep. Field names follow the provider's documentation (id, customer_no, call_time, call_duration, call_status, dtmf_input, dialer_name); other common names are accepted too.
function normalize(rec) {
  const id = String(pick(rec, ['id', 'recordid', 'log_id', 'logid', 'call_id', 'callid', 'uuid']) || '');
  const phone = tenDigits(pick(rec, ['customer_no', 'client_no', 'customer_number', 'customer', 'phone', 'mobile', 'number', 'caller', 'to']));
  const at = parseTime(pick(rec, ['call_time', 'start_time', 'created_at', 'time', 'datetime', 'calltime']));
  const seconds = Number(pick(rec, ['call_duration', 'duration', 'total_duration', 'cust_total', 'customer_duration']) || 0) || 0;
  let status = String(pick(rec, ['call_status', 'status', 'disposition', 'customer_status']) || '');
  // The provider's real log (read 2026-11-27) has no status word: it has customer_attended "1" (customer picked up) or "0" (did not).
  if (!status && rec && rec.customer_attended !== undefined && rec.customer_attended !== null && rec.customer_attended !== '') status = String(rec.customer_attended) === '1' ? 'answered' : 'missed';
  const dtmf = String(pick(rec, ['dtmf_input', 'dtmf', 'keypress', 'key', 'input']) || '').trim();
  let name = String(pick(rec, ['dialer_name', 'campaign_name', 'campaign', 'dialer']) || '');
  if (!name && rec && rec.dialer_id) name = 'dialer ' + rec.dialer_id;
  if (!id || phone.length !== 10 || !at) return null;
  return { id, phone, at, seconds, status, outcome: classify(status, seconds), dtmf, dialer: name };
}

// The provider's call time is when the call started; our placed_at is when the request was accepted, a moment earlier. Pick the nearest unmatched call of ours on the same phone within the window.
function matchOne(rec, ours, used = new Set(), { before = 3, after = 30 } = {}) {
  let best = null, bestGap = Infinity;
  for (const o of ours) {
    if (used.has(o.id) || tenDigits(o.phone) !== rec.phone) continue;
    const gap = (rec.at.getTime() - new Date(o.placed_at).getTime()) / 60000;      // minutes the provider call started after our request
    if (gap < -before || gap > after) continue;
    if (Math.abs(gap) < bestGap) { best = o; bestGap = Math.abs(gap); }
  }
  return best;
}

// Read a page of the provider's call logs. cursors: { dialer: '0' }. Returns { ok, records (normalized dialer stream), raw (first raw records), next, more, message }.
async function fetchPage({ http, apiKey, cursors = {} }) {
  const client = http || require('axios');
  if (!apiKey) return { ok: false, message: 'IVR_API_KEY is not set' };
  try {
    const res = await client.post(BASE + '/v1/all_call_logs', { last_c2c_log_id: '0', last_call_log_id: '0', last_dialer_log_id: String(cursors.dialer || '0') },
      { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 20000 });
    const d = res.data || {};
    const list = Array.isArray(d.dialer_logs) ? d.dialer_logs : [];
    return { ok: Number(d.status) === 200 || res.status === 200, records: list.map(normalize).filter(Boolean), raw: list.slice(0, 5), keys: list[0] ? Object.keys(list[0]) : [], total_raw: list.length,
      next: d.next_dialer_log_id !== undefined ? String(d.next_dialer_log_id) : null, more: !!(d.has_more && d.has_more.dialer_logs), message: String(d.message || '').slice(0, 200) };
  } catch (err) {
    const d = err.response && err.response.data;
    return { ok: false, message: String((d && (d.message || d.error)) || err.message || 'Request failed').slice(0, 200) };
  }
}

let ready = false;
async function ensureTables(db) {
  if (ready) return;
  await db(`CREATE TABLE IF NOT EXISTS ivr_provider_calls (
    provider_log_id TEXT PRIMARY KEY, phone10 TEXT NOT NULL, call_time TIMESTAMPTZ NOT NULL, seconds INT NOT NULL DEFAULT 0, status TEXT, outcome TEXT NOT NULL DEFAULT 'unknown', dtmf TEXT, dialer_name TEXT,
    ivr_call_id BIGINT, order_id UUID, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db(`CREATE INDEX IF NOT EXISTS ivr_provider_calls_phone_idx ON ivr_provider_calls (phone10, call_time)`);
  await db(`CREATE INDEX IF NOT EXISTS ivr_provider_calls_ivr_idx ON ivr_provider_calls (ivr_call_id)`);
  await db(`CREATE TABLE IF NOT EXISTS ivr_flags (name TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  ready = true;
}
const _reset = () => { ready = false; };

// Pull what is new, store it, match it to our calls. Returns a short summary. Safe to run again: records are stored once (by the provider's id), and a call of ours is matched to one provider call at most.
async function sync(db, now = new Date(), { http, env = process.env, maxPages = 5 } = {}) {
  const s = settings(env);
  if (!s.on) return { skipped: 'off' };
  await ensureTables(db);
  const cur = await db(`SELECT value FROM ivr_flags WHERE name = 'provider_dialer_cursor'`);
  let cursor = cur[0] ? cur[0].value : '0', stored = 0, matched = 0, pages = 0, last = null;
  while (pages < maxPages) {
    const r = await fetchPage({ http, apiKey: s.apiKey, cursors: { dialer: cursor } });
    pages++;
    if (!r.ok) return { error: r.message || 'provider request failed', stored, matched, pages };
    last = r;
    for (const rec of r.records) {
      const ins = await db(`INSERT INTO ivr_provider_calls (provider_log_id, phone10, call_time, seconds, status, outcome, dtmf, dialer_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (provider_log_id) DO NOTHING RETURNING provider_log_id`,
        [rec.id, rec.phone, rec.at, rec.seconds, rec.status.slice(0, 40), rec.outcome, rec.dtmf.slice(0, 5), rec.dialer.slice(0, 80)]);
      if (ins.length) stored++;
    }
    if (r.next && r.next !== cursor) { cursor = r.next; await db(`INSERT INTO ivr_flags (name, value) VALUES ('provider_dialer_cursor', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [cursor]); }
    if (!r.more) break;
  }
  matched = await matchPending(db, now);
  return { stored, matched, pages, cursor, last_keys: last && last.keys };
}

// Match provider calls not yet matched to our calls of the last 3 days.
async function matchPending(db, now = new Date()) {
  const since = new Date(new Date(now).getTime() - 3 * 86400e3);
  const open = await db(`SELECT provider_log_id, phone10, call_time FROM ivr_provider_calls WHERE ivr_call_id IS NULL AND call_time >= $1 ORDER BY call_time`, [since]);
  if (!open.length) return 0;
  const ours = await db(`SELECT id, order_id, phone, placed_at FROM ivr_calls WHERE NOT is_test AND status IN ('placed', 'answered') AND placed_at >= $1 AND placed_at <= $2`, [new Date(since.getTime() - 3600e3), new Date(new Date(now).getTime() + 3600e3)]);
  const taken = new Set((await db(`SELECT ivr_call_id FROM ivr_provider_calls WHERE ivr_call_id IS NOT NULL AND call_time >= $1`, [since])).map(x => Number(x.ivr_call_id)));
  let n = 0;
  for (const p of open) {
    const hit = matchOne({ phone: p.phone10, at: new Date(p.call_time) }, ours, taken);
    if (!hit) continue;
    taken.add(Number(hit.id));
    await db(`UPDATE ivr_provider_calls SET ivr_call_id = $2, order_id = $3 WHERE provider_log_id = $1`, [p.provider_log_id, hit.id, hit.order_id]);
    n++;
  }
  return n;
}

// The reconciliation for the Home IVR view: our calls of the chosen dates against the provider's own record of them.
async function check(db, from, to) {
  await ensureTables(db);
  const day = (d) => `((${d} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date)`;
  const ours = (await db(`SELECT COUNT(*)::int AS placed, COUNT(*) FILTER (WHERE result IS NOT NULL)::int AS pressed FROM ivr_calls WHERE NOT is_test AND status IN ('placed', 'answered') AND ${day('placed_at')}`, [from, to]))[0];
  const m = (await db(`SELECT COUNT(*)::int AS matched, COUNT(*) FILTER (WHERE p.outcome = 'answered')::int AS answered, COUNT(*) FILTER (WHERE p.outcome = 'missed')::int AS missed, COUNT(*) FILTER (WHERE p.outcome = 'unknown')::int AS unknown,
        COUNT(*) FILTER (WHERE p.outcome = 'answered' AND i.result IS NULL)::int AS answered_no_key, COALESCE(SUM(p.seconds) FILTER (WHERE p.outcome = 'answered'), 0)::int AS answered_seconds
      FROM ivr_calls i JOIN ivr_provider_calls p ON p.ivr_call_id = i.id WHERE NOT i.is_test AND ${day('i.placed_at')}`, [from, to]))[0];
  const stray = (await db(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE COALESCE(dialer_name, '') = '')::int AS no_campaign FROM ivr_provider_calls WHERE ivr_call_id IS NULL AND ${day('call_time')}`, [from, to]))[0];
  const last = (await db(`SELECT MAX(call_time) AS t, MAX(fetched_at) AS f FROM ivr_provider_calls`))[0];
  return { from, to, our_calls_placed: ours.placed, our_keys_pressed: ours.pressed, found_at_provider: m.matched, answered: m.answered, answered_and_pressed_a_key: m.answered - m.answered_no_key, answered_no_key: m.answered_no_key, missed: m.missed, status_unknown: m.unknown,
    not_found_at_provider: Math.max(0, ours.placed - m.matched), answered_seconds: m.answered_seconds, provider_calls_not_ours: stray.n, provider_last_call_at: last && last.t, provider_last_fetch_at: last && last.f };
}

module.exports = { BASE, settings, normalize, classify, parseTime, matchOne, fetchPage, ensureTables, sync, matchPending, check, tenDigits, _reset };
