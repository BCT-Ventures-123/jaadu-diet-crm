// When do customers pick up? One number per hour of the day (India time), learned from your own calls. Pure: no database here (the rows come from lib/ivrDb.js hourData()).
//   human rows: { hour, calls, connected, retry_calls, retry_connected }   calls made by Aman and the call centre on COD orders in the last 30 days; "retry" = the second call or later on an order,
//               which is the population the IVR works (leads that did not pick up before). connected = the customer spoke.
//   ivr rows:   { hour, placed, pressed }                                  the IVR's own real calls; pressed = the customer pressed a key.
// The two sources pick up at different levels (people answer a caller more often than an IVR), so each hour is first turned into an INDEX against its own source's average
// (1.0 = average, 1.5 = half as good again as average). The IVR's own evidence takes over from the callers' as it grows: index = (human * k + ivr * placed) / (k + placed).
const num = (v) => Number(v) || 0;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const label = (h) => { const f = (x) => (x % 12 || 12) + (x % 24 >= 12 ? ' PM' : ' AM'); return f(h) + '–' + f(h + 1); };

function settings(env = process.env) {
  const n = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
  return { from: n(env.IVR_SMART_FROM, 9), to: n(env.IVR_SMART_TO, 21), maxHours: n(env.IVR_SMART_HOURS, 6), minCalls: n(env.IVR_SMART_MIN_CALLS, 30), k: n(env.IVR_SMART_K, 20) };
}

function build({ human = [], ivr = [] } = {}, s = settings()) {
  const H = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, connected: 0, retry_calls: 0, retry_connected: 0, ivr_placed: 0, ivr_pressed: 0 }));
  for (const r of human) { const x = H[num(r.hour)]; if (x) { x.calls += num(r.calls); x.connected += num(r.connected); x.retry_calls += num(r.retry_calls); x.retry_connected += num(r.retry_connected); } }
  for (const r of ivr) { const x = H[num(r.hour)]; if (x) { x.ivr_placed += num(r.placed); x.ivr_pressed += num(r.pressed); } }
  // The callers' side counts RETRIES only. An hour with too few retries has no evidence: it is never filled in from first calls, which pick up far better and would make that hour look best.
  const useRetry = () => true;
  const hCalls = (x) => x.retry_calls, hConn = (x) => x.retry_connected;
  const tHC = H.reduce((a, x) => a + (hCalls(x) >= s.minCalls ? hCalls(x) : 0), 0), tHK = H.reduce((a, x) => a + (hCalls(x) >= s.minCalls ? hConn(x) : 0), 0);
  const tIP = H.reduce((a, x) => a + x.ivr_placed, 0), tIK = H.reduce((a, x) => a + x.ivr_pressed, 0);
  const hAvg = tHC ? tHK / tHC : null, iAvg = tIP >= s.minCalls ? tIK / tIP : null;
  const hours = H.map(x => {
    const hRate = hCalls(x) >= s.minCalls ? hConn(x) / hCalls(x) : null;
    const iRate = x.ivr_placed > 0 ? x.ivr_pressed / x.ivr_placed : null;
    const hIdx = hRate != null && hAvg ? hRate / hAvg : null, iIdx = iRate != null && iAvg ? iRate / iAvg : null;
    let index = null;
    if (hIdx != null && iIdx != null) index = (hIdx * s.k + iIdx * x.ivr_placed) / (s.k + x.ivr_placed);
    else if (hIdx != null) index = hIdx;
    else if (iIdx != null && x.ivr_placed >= s.minCalls) index = iIdx;
    return { hour: x.hour, label: label(x.hour), calls: hCalls(x), connected: hConn(x), pickup_pct: pct(hConn(x), hCalls(x)), from_retries: useRetry(x), ivr_placed: x.ivr_placed, ivr_pressed: x.ivr_pressed,
      ivr_pct: pct(x.ivr_pressed, x.ivr_placed), index: index == null ? null : Math.round(index * 100) / 100, enough: index != null, allowed: x.hour >= s.from && x.hour < s.to, chosen: false };
  });
  // The smart hours: inside the allowed hours, the ones with enough evidence that beat the average, best first, at most maxHours of them.
  const picked = hours.filter(h => h.allowed && h.enough && h.index >= 1).sort((a, b) => b.index - a.index).slice(0, s.maxHours);
  picked.forEach(p => { hours[p.hour].chosen = true; });
  return { hours, smart_hours: picked.map(p => p.hour).sort((a, b) => a - b), human_avg_pct: hAvg == null ? null : Math.round(hAvg * 1000) / 10, ivr_avg_pct: iAvg == null ? null : Math.round(iAvg * 1000) / 10,
    samples: { human_calls: tHC, ivr_calls: tIP }, rule: { from: s.from, to: s.to, max_hours: s.maxHours, min_calls: s.minCalls } };
}

// Is this minute inside one of the smart hours, and what share of the day's no-answer calls belongs to this hour (better hours get more)? With too little data to choose
// hours, every allowed hour counts equally, so the campaign still runs in the day.
function smartNow(curve, now) {
  const hour = new Date(new Date(now).getTime() + 5.5 * 3600e3).getUTCHours();
  if (!curve || !curve.hours) return { open: false, hour, share: 0 };
  let set = curve.hours.filter(x => x.chosen).map(x => ({ hour: x.hour, w: x.index || 1 }));
  if (!set.length) set = curve.hours.filter(x => x.allowed).map(x => ({ hour: x.hour, w: 1 }));
  const me = set.find(x => x.hour === hour);
  if (!me) return { open: false, hour, share: 0 };
  const sum = set.reduce((a, x) => a + x.w, 0);
  return { open: true, hour, share: sum ? me.w / sum : 1 / set.length, hours: set.map(x => x.hour) };
}

module.exports = { build, settings, label, smartNow };
