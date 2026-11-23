// Moves fresh leads from the call-centre queue to Aman when Aman has run dry.
// Pure rules here; the database part is in balanceDb.js.
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);

function settings(env = process.env) {
  return {
    auto: String(env.AUTO_BALANCE || 'off').toLowerCase() === 'on',   // off by default: Aman no longer pulls leads from the call centre (the autopilot hands over failed leads instead)
    minAman: num(env.BALANCE_MIN_AMAN, 8),       // Aman counts as "free" below this many open leads
    keepCc: num(env.BALANCE_KEEP_CC, 15),        // never drain the call centre below this automatically
    batch: num(env.BALANCE_BATCH, 15),           // leads moved per run
    startHour: num(env.BALANCE_START_HOUR, 9),   // IST, decimal hours
    endHour: num(env.BALANCE_END_HOUR, 13.5),    // stop before the 2 PM dispatch cut-off
  };
}

function istHour(now = new Date()) {
  const [h, m] = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h + m / 60;
}

function inWindow(now, s) {
  const h = istHour(now);
  return h >= s.startHour && h < s.endHour;
}

// requested = a number when someone presses "Get more leads"; undefined for the automatic run.
function planMove({ amanOpen, ccMovable }, s, requested) {
  if (requested !== undefined && requested !== null) return Math.max(0, Math.min(Math.floor(requested), ccMovable));
  if (amanOpen >= s.minAman) return 0;
  return Math.max(0, Math.min(s.batch, ccMovable - s.keepCc));
}

module.exports = { settings, inWindow, planMove, istHour };
