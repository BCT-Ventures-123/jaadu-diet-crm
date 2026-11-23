// Is a shipping address too short to deliver? One rule, used when an order arrives and when old orders are re-checked.
// The PRD rule is length only (under 25 characters). The older extra check, "must contain a word like house / flat / near",
// wrongly flagged complete addresses (e.g. "Vill Rampur Post Sadar Dist Bareilly UP"), so it is off unless requirePremise is set.
const PREMISE = /\b(house|flat|plot|no\.|floor|apartment|apt|bldg|building|block|sector|lane|gali|near|opp|behind|next to)\b/i;

function isShortAddress(addr, opt = {}) {
  const { minChars = 25, minWords = 4, requirePremise = false } = opt;
  const a = String(addr || '').trim();
  if (!a) return true;
  if (a.length < minChars) return true;
  if (a.split(/\s+/).length < minWords) return true;
  if (requirePremise && !PREMISE.test(a)) return true;
  return false;
}

// The text that is checked: address lines, city and state joined, exactly as the order is ingested.
const fullAddressOf = (o) => [o.shipping_address1, o.shipping_address2, o.shipping_city, o.shipping_province].filter(Boolean).join(' ');

module.exports = { isShortAddress, fullAddressOf, PREMISE };
