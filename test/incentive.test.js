const test = require('node:test');
const assert = require('node:assert');
const { evaluateIncentive, summarizeIncentives } = require('../lib/incentive');

const link = { agent_name: 'Priya' };
const paid = (amount) => ({ status: 'paid', amount });

test('paid 599 on an agent link earns Rs 10', () => {
  assert.deepEqual(evaluateIncentive({ link, payment: paid(599) }), { credit: true, amount: 10 });
});

test('overpayment still earns', () => {
  assert.equal(evaluateIncentive({ link, payment: paid(650) }).credit, true);
});

test('unpaid, short-paid, duplicate and agent-less links earn nothing', () => {
  assert.equal(evaluateIncentive({ link, payment: { status: 'created', amount: 599 } }).reason, 'not_paid');
  assert.equal(evaluateIncentive({ link, payment: paid(500) }).reason, 'amount_too_low');
  assert.equal(evaluateIncentive({ link, payment: paid(599), alreadyCredited: true }).reason, 'already_credited');
  assert.equal(evaluateIncentive({ link: null, payment: paid(599) }).reason, 'no_agent_link');
  assert.equal(evaluateIncentive({ link: {}, payment: paid(599) }).reason, 'no_agent_link');
});

test('summary groups by agent and sorts by amount', () => {
  const rows = [
    { agent_name: 'Priya', amount: 10 }, { agent_name: 'Ravi', amount: 10 },
    { agent_name: 'Priya', amount: 10 }, { agent_name: 'Priya', amount: 10 },
  ];
  assert.deepEqual(summarizeIncentives(rows), [
    { agent_name: 'Priya', conversions: 3, amount: 30 },
    { agent_name: 'Ravi', conversions: 1, amount: 10 },
  ]);
  assert.deepEqual(summarizeIncentives([]), []);
});
