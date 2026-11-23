// The END-TO-END check: take real orders that were confirmed in the last day, a few per channel (Aman, call centre, IVR, WhatsApp, the old sheet), and prove each one went all the way:
//   1. the Home report counts it, under the channel that confirmed it
//   2. the attempts log has the attempt of that channel
//   3. the logistics gate (the ship feed) has it, ready or blocked with a reason
//   4. Shopify carries the "confirmed" tag
// Pure comparison; the route loads the data (cc_routes.js /api/cc/pipeline-check).
//   samples: [{ id, name, channel: 'aman'|'cc'|'ivr'|'wa'|'sheet'|'other', tag_synced: boolean, shopify_id }]
//   reportIds: Set of order ids the Home report counts      reportChannel: Map(order id -> channel the ledger credits the decision to)
//   attemptTeams: Map(order id -> Set of channels that have an attempt)
//   gate: Map(order id -> 'ready'|'blocked'|'untracked'|'wrong')
//   tags: Map(shopify id -> tags string) or null when Shopify could not be read
const HOPS = [['report', 'Counted in the Home report'], ['attempt', 'Attempt is in the attempts log'], ['logistics', 'Reached the logistics gate'], ['shopify', 'Shopify has the confirmed tag']];
const hasTag = (tags) => String(tags || '').split(',').map(s => s.trim().toLowerCase()).includes('confirmed');
const CHANNELS = [['aman', 'Aman'], ['cc', 'Call centre'], ['ivr', 'IVR'], ['wa', 'WhatsApp'], ['sheet', 'Old sheet'], ['other', 'Other']];

function check(samples, ctx) {
  const out = [];
  for (const [key, label] of CHANNELS) {
    const list = samples.filter(s => s.channel === key);
    if (!list.length) { out.push({ channel: key, label, n: 0, hops: [] }); continue; }
    const res = {}; HOPS.forEach(([h]) => { res[h] = { pass: 0, of: 0, bad: [] }; });
    for (const s of list) {
      const hop = (h, ok, na) => { if (na) return; res[h].of++; if (ok) res[h].pass++; else if (res[h].bad.length < 8) res[h].bad.push(s.name); };
      hop('report', ctx.reportIds.has(s.id) && (ctx.reportChannel.get(s.id) === key));
      hop('attempt', (ctx.attemptTeams.get(s.id) || new Set()).has(key), key === 'sheet' || key === 'other');       // the old sheet leaves no attempt of its own
      hop('logistics', ctx.gate.has(s.id));
      hop('shopify', s.tag_synced || (ctx.tags && hasTag(ctx.tags.get(String(s.shopify_id)))), false);
    }
    out.push({ channel: key, label, n: list.length, hops: HOPS.map(([h, text]) => ({ hop: h, text, ...res[h] })) });
  }
  const failed = out.reduce((a, c) => a + c.hops.reduce((b, h) => b + (h.of - h.pass), 0), 0);
  return { ok: failed === 0, failed, channels: out };
}

// Which channel confirmed an order, for the sample (same rule as the ledger).
const channelOf = (actor, role) => require('./ledger').decidedBy({ actor, actor_role: role });

module.exports = { check, channelOf, hasTag, HOPS, CHANNELS };
