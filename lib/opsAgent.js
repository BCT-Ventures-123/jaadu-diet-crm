// Ops manager agent, step 1: it reads the numbers and writes a brief. It changes nothing in the CRM (rules and checks are in lib/opsBrief.js).
//   ANTHROPIC_API_KEY   set in Railway by the owner. Without it the plain rule-based brief is used.
//   OPS_AGENT_MODEL     default claude-haiku-5-5 (small and cheap; the brief is short)
//   OPS_AGENT_DAILY_CALLS  most AI calls per day (default 20), so the cost stays capped
const brief = require('./opsBrief');
const { istHour } = require('./balance');

const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
const settings = (env = process.env) => ({ key: env.ANTHROPIC_API_KEY || '', model: env.OPS_AGENT_MODEL || 'claude-haiku-5-5', dailyCalls: num(env.OPS_AGENT_DAILY_CALLS, 20), staleMinutes: num(env.OPS_AGENT_STALE_MINUTES, 55), startHour: num(env.AUTOPILOT_START_HOUR, 9), endHour: num(env.AUTOPILOT_END_HOUR, 20) });

let ready = false;
async function ensureTable(db) {
  if (ready) return;
  await db(`CREATE TABLE IF NOT EXISTS ops_briefs (
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL, model TEXT, headline TEXT, items JSONB, good TEXT,
    facts JSONB, tokens_in INT, tokens_out INT, note TEXT)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_ops_briefs_at ON ops_briefs (created_at DESC)`);
  ready = true;
}

async function askClaude(prompt, s, http) {
  const r = await (http || require('axios')).post('https://api.anthropic.com/v1/messages',
    { model: s.model, max_tokens: 700, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] },
    { headers: { 'x-api-key': s.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
  const d = r.data || {};
  return { text: (d.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), tokens_in: d.usage && d.usage.input_tokens, tokens_out: d.usage && d.usage.output_tokens };
}

const row = (r) => r && ({ id: r.id, created_at: r.created_at, source: r.source, model: r.model, headline: r.headline, items: r.items || [], good: r.good || '', note: r.note || null });

async function latest(db) { await ensureTable(db); return row((await db(`SELECT * FROM ops_briefs ORDER BY created_at DESC LIMIT 1`))[0]); }
async function recent(db, n = 8) { await ensureTable(db); return (await db(`SELECT id, created_at, source, headline, note FROM ops_briefs ORDER BY created_at DESC LIMIT $1`, [n])).map(row); }

// inputs: { tower, plan } already loaded by the caller. Returns the stored brief.
async function generate(db, inputs, { now = new Date(), env = process.env, http = null } = {}) {
  await ensureTable(db);
  const s = settings(env), facts = brief.collectFacts({ ...inputs, now });
  let aiText = null, tokens = {}, note = null, model = null;
  if (!s.key) note = 'AI writing is off (no ANTHROPIC_API_KEY in Railway), so this is the plain brief.';
  else {
    const today = await db(`SELECT COUNT(*)::int AS n FROM ops_briefs WHERE source = 'ai' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`);
    if ((today[0] && today[0].n) >= s.dailyCalls) note = `Daily AI limit (${s.dailyCalls}) reached, so this is the plain brief.`;
    else {
      try { const r = await askClaude(brief.buildPrompt(facts), s, http); aiText = r.text; tokens = r; model = s.model; }
      catch (err) { note = 'The AI service did not answer (' + String((err.response && err.response.status) || err.code || err.message).slice(0, 60) + '), so this is the plain brief.'; console.error('[OpsAgent] AI call failed:', err.message); }
    }
  }
  const chosen = brief.chooseBrief(aiText, facts), b = chosen.brief;
  const saved = await db(`INSERT INTO ops_briefs (source, model, headline, items, good, facts, tokens_in, tokens_out, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.source, b.source === 'ai' ? model : null, b.headline, JSON.stringify(b.items), b.good, JSON.stringify(facts), tokens.tokens_in || null, tokens.tokens_out || null, chosen.note || note]);
  return row(saved[0]);
}

const inShift = (now, s) => { const h = istHour(now); return h >= s.startHour && h < s.endHour; };
const isStale = (l, now, s) => !l || (new Date(now) - new Date(l.created_at)) > s.staleMinutes * 60000;

module.exports = { settings, ensureTable, askClaude, latest, recent, generate, inShift, isStale };
