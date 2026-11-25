// Warm leads: orders whose WhatsApp message the customer READ but did not tap or answer (owner 2026-11-25). The callers' queue puts them first inside a tier (lib/queue.js).
// Returns a Set of order ids. If the WhatsApp tables do not exist yet, or anything fails, nobody is warm and the queue works as before.
async function warmIds(db, ids) {
  if (!ids || !ids.length) return new Set();
  try {
    const rows = await db(`SELECT w.order_id FROM wa_messages w
        WHERE w.order_id = ANY($1) AND NOT w.is_test AND w.read_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM wa_events e WHERE e.order_id = w.order_id AND e.event IN ('clicked_confirm', 'clicked_cancel', 'clicked_change_address', 'replied_text'))
        GROUP BY w.order_id`, [ids]);
    return new Set(rows.map(r => r.order_id));
  } catch (e) { return new Set(); }
}

module.exports = { warmIds };
