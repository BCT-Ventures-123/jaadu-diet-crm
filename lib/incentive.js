const cfg = require('./config');

// Decide whether a payment confirmation earns the agent an incentive.
// Only a real, paid, sufficiently large payment on a link sent by an agent counts.
function evaluateIncentive({ link, payment, expectedAmount = cfg.PREPAID_AMOUNT, perConversion = cfg.INCENTIVE_PER_CONVERSION, alreadyCredited = false }) {
  if (alreadyCredited) return { credit: false, reason: 'already_credited' };
  if (!link || !link.agent_name) return { credit: false, reason: 'no_agent_link' };
  if (!payment || payment.status !== 'paid') return { credit: false, reason: 'not_paid' };
  if (Number(payment.amount) < Number(expectedAmount)) return { credit: false, reason: 'amount_too_low' };
  return { credit: true, amount: perConversion };
}

// rows: [{agent_name, amount}] -> [{agent_name, conversions, amount}] sorted by amount desc, then name
function summarizeIncentives(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const cur = by.get(r.agent_name) || { agent_name: r.agent_name, conversions: 0, amount: 0 };
    cur.conversions += 1;
    cur.amount += Number(r.amount) || 0;
    by.set(r.agent_name, cur);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount || a.agent_name.localeCompare(b.agent_name));
}

module.exports = { evaluateIncentive, summarizeIncentives };
