// Single place for call-centre business rules. Override via env where noted.
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  TIMEZONE: 'Asia/Kolkata',
  // Calling in this CRM began on this date (India time). Orders placed before it have no call history here, so reports and the open backlog treat them as out of scope. Override with CALLING_STARTED_ON.
  CALLING_STARTED_ON: process.env.CALLING_STARTED_ON || '2026-10-26',

  // DNP / follow-up rules
  // Owner rule 2026-11-23: every no-answer lead gets a SECOND call the same day, about 3 hours after the first, before the 2 PM cut-off where possible (the November data showed 77% of the call centre's no-answer leads had only one try).
  DNP_MIN_DAILY_ATTEMPTS: num(process.env.DNP_MIN_DAILY_ATTEMPTS, 2),
  // After this many no-answer tries by people (Aman or the call centre, all days together) the lead leaves their queues and the IVR takes it: one call a day in the best hours, up to 5 days. Stops a few leads using 12 to 18 calls.
  CALLER_MAX_TRIES: num(process.env.CALLER_MAX_TRIES, 4),
  DNP_MAX_DAILY_ATTEMPTS: num(process.env.DNP_MAX_DAILY_ATTEMPTS, 5),
  DNP_MIN_GAP_MINUTES: num(process.env.DNP_MIN_GAP_MINUTES, 90),
  // A lead that has not had its minimum tries today and whose last try was at least this long ago is called before ordinary fresh leads,
  // so second and third tries actually happen when many new orders come in. Brand-new (under 1 h) and over-24-h leads still go first.
  DNP_RETRY_PRIORITY_MINUTES: num(process.env.DNP_RETRY_PRIORITY_MINUTES, 180),
  FOLLOWUP_DAYS: num(process.env.CC_FOLLOWUP_DAYS, 7),

  // Prepaid conversion
  PREPAID_AMOUNT: num(process.env.PREPAID_AMOUNT, 599),
  INCENTIVE_PER_CONVERSION: num(process.env.INCENTIVE_PER_CONVERSION, 10),

  // KPI targets
  TARGET_CONNECTIVITY_PCT: 95,   // at least
  TARGET_CANCELLED_PCT: 5,       // at most

  // Dispositions
  // Every call outcome the agent records. Each one counts as one "attempt" in reports.
  CALL_DISPOSITIONS: ['confirmed', 'cancelled', 'dnp', 'callback', 'address_fix', 'wrong_number', 'dnc', 'escalated'],
  // Outcomes where a human picked up. Edit this list to change how "connected" is measured.
  CONNECTED_DISPOSITIONS: ['confirmed', 'cancelled', 'callback', 'address_fix', 'dnc', 'escalated'],

  CANCEL_REASONS: {
    does_not_want: 'Does not want the order',
    did_not_order: 'Did not place the order',
    wrong_address: 'Wrong address',
    price: 'Price',
    other: 'Other',
  },
};
