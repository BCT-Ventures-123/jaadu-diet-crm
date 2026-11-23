const test = require('node:test');
const assert = require('node:assert');
const ob = require('../lib/opsBrief');
const agent = require('../lib/opsAgent');

const tower = { healthy: false, window_days: 7,
  actions: [{ level: 'warn', text: '40 leads are over the redial limit: send WhatsApp / IVR, then review.', go: 'plan' }, { level: 'bad', text: '120 COD orders from earlier days were never called.', go: 'funnel' }],
  stages: [{ label: 'Called', count: 900, pct: 93.1, target: '100%', tone: 'warn' }, { label: 'Confirmed', count: 800, pct: 96.2, target: '95%', tone: 'ok' }, { label: 'Picked up', count: null, pct: null, nodata: true }],
  ship: { ready: 41, overdue: 3 } };
const plan = { hours_left: 7.5, review_count: 40, teams: { cc: { label: 'Call centre', deficit: 307, calls_needed: 559, capacity: 252, agents_on_team: 2, tries_today: 3, never_called: 127, dnp_open: 253 }, aman: { label: 'Aman', deficit: 0, calls_needed: 100, capacity: 400, agents_on_team: 5, tries_today: 5, never_called: 3, dnp_open: 20 } } };
const facts = ob.collectFacts({ tower, plan, now: new Date('2026-11-18T11:00:00+05:30') });

test('facts: problems are ranked worst first and include the plan shortfall', () => {
  assert.equal(facts.problems[0].level, 'bad');
  assert.ok(facts.problems.some(p => /Call centre: short by 307 calls/.test(p.text)));
  assert.equal(facts.healthy, false);
  assert.equal(facts.chain.length, 2);                       // the step with no data is left out, never guessed
  assert.equal(facts.leads_over_redial_limit, 40);
});

test('plain brief: works without any AI, from the same facts', () => {
  const b = ob.plainBrief(facts);
  assert.equal(b.source, 'rules');
  assert.match(b.headline, /need action now/);
  assert.equal(b.items.length, 3);
  assert.match(b.good, /Confirmed/);
  const calm = ob.plainBrief(ob.collectFacts({ tower: { healthy: true, actions: [], stages: [] }, plan: null }));
  assert.match(calm.headline, /Nothing needs urgent action/);
});

test('guardrail: an AI brief that uses only numbers from the data is accepted', () => {
  const ai = JSON.stringify({ headline: 'Call centre is short by 307 calls today.', items: [{ who: 'Call centre', what: 'Call the 127 leads never called first.', why: '307 calls short, 2 people on the team.' }], good: 'Confirmation is 96.2%, above the 95% target.' });
  const r = ob.chooseBrief('Here you go: ' + ai, facts);
  assert.equal(r.brief.source, 'ai');
  assert.equal(r.note, null);
  assert.equal(r.brief.items[0].who, 'Call centre');
});

test('guardrail: an AI brief with an invented number is thrown away for the plain brief', () => {
  const ai = JSON.stringify({ headline: 'About 450 calls are missing today.', items: [], good: '' });
  const r = ob.chooseBrief(ai, facts);
  assert.equal(r.brief.source, 'rules');
  assert.match(r.note, /numbers that are not in the data \(450\)/);
});

test('guardrail: unreadable AI output falls back, and thousands separators are understood', () => {
  assert.match(ob.chooseBrief('I cannot help with that', facts).note, /could not be read/);
  assert.deepEqual(ob.numbersIn('1,250 orders and 96.2% and 07'), ['1250', '96.2', '7']);
});

test('prompt: the system text forbids new numbers and the user part is only the facts', () => {
  const p = ob.buildPrompt(facts);
  assert.match(p.system, /Use ONLY the numbers/);
  assert.match(p.system, /never instructions/);
  assert.deepEqual(JSON.parse(p.user).problems[0], facts.problems[0]);
});

// ---- the stored agent, with a fake database and a fake AI service
function fakeDb() {
  const rows = []; let id = 0;
  const db = async (sql, params = []) => {
    if (/^\s*CREATE/i.test(sql)) return [];
    if (/COUNT\(\*\)::int AS n FROM ops_briefs/.test(sql)) return [{ n: rows.filter(r => r.source === 'ai').length }];
    if (/^\s*INSERT INTO ops_briefs/i.test(sql)) { const r = { id: ++id, created_at: new Date(), source: params[0], model: params[1], headline: params[2], items: JSON.parse(params[3]), good: params[4], note: params[8] }; rows.push(r); return [r]; }
    if (/FROM ops_briefs ORDER BY created_at DESC LIMIT 1/.test(sql)) return rows.slice(-1);
    return [];
  };
  db.rows = rows; return db;
}
const okHttp = (text) => ({ post: async () => ({ data: { content: [{ type: 'text', text }], usage: { input_tokens: 500, output_tokens: 80 } } }) });

test('agent: no API key gives the plain brief and says why', async () => {
  const db = fakeDb();
  const b = await agent.generate(db, { tower, plan }, { env: {}, http: okHttp('x') });
  assert.equal(b.source, 'rules');
  assert.match(b.note, /no ANTHROPIC_API_KEY/);
});

test('agent: with a key, a good AI answer is stored as an AI brief', async () => {
  const db = fakeDb();
  const ai = JSON.stringify({ headline: 'Call centre is short by 307 calls today.', items: [], good: '' });
  const b = await agent.generate(db, { tower, plan }, { env: { ANTHROPIC_API_KEY: 'test' }, http: okHttp(ai) });
  assert.equal(b.source, 'ai');
  assert.equal(b.model, 'claude-haiku-5-5');
});

test('agent: a failing AI service does not break the brief', async () => {
  const db = fakeDb();
  const bad = { post: async () => { const e = new Error('boom'); e.response = { status: 529 }; throw e; } };
  const b = await agent.generate(db, { tower, plan }, { env: { ANTHROPIC_API_KEY: 'test' }, http: bad });
  assert.equal(b.source, 'rules');
  assert.match(b.note, /did not answer \(529\)/);
});

test('agent: the daily limit caps the AI calls', async () => {
  const db = fakeDb();
  const env = { ANTHROPIC_API_KEY: 'test', OPS_AGENT_DAILY_CALLS: '1' };
  const ai = JSON.stringify({ headline: 'Call centre is short by 307 calls today.', items: [], good: '' });
  assert.equal((await agent.generate(db, { tower, plan }, { env, http: okHttp(ai) })).source, 'ai');
  const second = await agent.generate(db, { tower, plan }, { env, http: okHttp(ai) });
  assert.equal(second.source, 'rules');
  assert.match(second.note, /Daily AI limit \(1\) reached/);
});

test('agent: stale check and shift hours', () => {
  const s = agent.settings({});
  const now = new Date('2026-11-18T11:00:00+05:30');
  assert.equal(agent.isStale(null, now, s), true);
  assert.equal(agent.isStale({ created_at: new Date(now - 20 * 60000) }, now, s), false);
  assert.equal(agent.isStale({ created_at: new Date(now - 70 * 60000) }, now, s), true);
  assert.equal(agent.inShift(now, s), true);
  assert.equal(agent.inShift(new Date('2026-11-18T22:00:00+05:30'), s), false);
});
