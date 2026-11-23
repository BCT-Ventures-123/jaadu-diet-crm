const cfg = require('./config');

function istDateKey(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
}

// attemptTimes: array of Date/ISO strings, one per DNP attempt (any order).
function dnpStatus(attemptTimes, now = new Date(), rules = cfg) {
  const times = (attemptTimes || []).filter(t => t !== null && t !== undefined && t !== '')
    .map(t => new Date(t)).filter(d => !isNaN(d)).sort((a, b) => a - b);
  const today = istDateKey(now);
  const todays = times.filter(t => istDateKey(t) === today);
  const last = times.length ? times[times.length - 1] : null;
  const minutesSinceLast = last ? Math.floor((new Date(now) - last) / 60000) : null;

  const tooSoon = minutesSinceLast !== null
    && minutesSinceLast >= 0
    && minutesSinceLast < rules.DNP_MIN_GAP_MINUTES;
  const atMax = todays.length >= rules.DNP_MAX_DAILY_ATTEMPTS;
  const belowTarget = todays.length < rules.DNP_MIN_DAILY_ATTEMPTS;

  let hint = null;
  if (atMax) {
    hint = `Daily maximum of ${rules.DNP_MAX_DAILY_ATTEMPTS} attempts reached. Try again tomorrow.`;
  } else if (tooSoon) {
    hint = `Last attempt was ${minutesSinceLast} min ago. Wait about ${rules.DNP_MIN_GAP_MINUTES - minutesSinceLast} more min (aim for ${rules.DNP_MIN_GAP_MINUTES}+).`;
  }

  return {
    totalAttempts: times.length,
    todayCount: todays.length,
    minutesSinceLast,
    tooSoon,
    atMax,
    belowTarget,
    neededToday: Math.max(0, rules.DNP_MIN_DAILY_ATTEMPTS - todays.length),
    hint,
  };
}

// True when the order is older than the follow-up window and should be marked Unreachable.
function isUnreachableDue(orderCreatedAt, now = new Date(), days = cfg.FOLLOWUP_DAYS) {
  const created = new Date(orderCreatedAt);
  if (isNaN(created)) return false;
  return new Date(now) - created >= days * 24 * 3600 * 1000;
}

module.exports = { dnpStatus, isUnreachableDue, istDateKey };
