// Validates a requested callback time (ISO string from the browser, with timezone offset).
function validateCallback(callbackAt, now = new Date(), maxDays = 30) {
  if (!callbackAt) return { ok: false, error: 'Callback date and time required' };
  const when = new Date(callbackAt);
  if (isNaN(when)) return { ok: false, error: 'Invalid callback date/time' };
  if (when.getTime() <= new Date(now).getTime()) return { ok: false, error: 'Callback time must be in the future' };
  if (when.getTime() - new Date(now).getTime() > maxDays * 24 * 3600 * 1000) {
    return { ok: false, error: `Callback cannot be more than ${maxDays} days away` };
  }
  return { ok: true, when };
}

// A lead is in the main queue when it has no callback, or its callback time has arrived.
function isInMainQueue(lead, now = new Date()) {
  if (lead.dnc) return false;
  if (!lead.callback_at) return true;
  return new Date(lead.callback_at) <= new Date(now);
}

// Badge shown on the lead row: 'due' once the callback time has arrived.
function callbackBadge(lead, now = new Date()) {
  if (!lead.callback_at) return null;
  return new Date(lead.callback_at) <= new Date(now) ? 'due' : 'scheduled';
}

module.exports = { validateCallback, isInMainQueue, callbackBadge };
