// Database side of load balancing and lead re-queueing. `db(sql, params)` returns rows.
const LOCK_MINUTES = 15;

async function counts(db) {
  const [a] = await db(
    `SELECT COUNT(*)::int AS n FROM orders_master
     WHERE assigned_to = 'InHouse' AND confirmation_status = 'pending' AND order_status = 'new'
       AND is_duplicate = FALSE AND dnc = FALSE AND (callback_at IS NULL OR callback_at <= NOW())`);
  const [c] = await db(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE v.callback_at IS NULL
              AND (v.lead_locked_by IS NULL OR v.lead_locked_at < NOW() - ($1 || ' minutes')::interval))::int AS movable
     FROM v_cc_fresh_leads v`, [String(LOCK_MINUTES)]);
  return { amanOpen: a.n, ccOpen: c.open, ccMovable: c.movable };
}

// Oldest call-centre leads first (they are closest to the dispatch cut-off).
async function moveLeads(db, n, who) {
  if (n <= 0) return [];
  const rows = await db(
    `WITH pick AS (
       SELECT o.id FROM orders_master o JOIN v_cc_fresh_leads v ON v.id = o.id
       WHERE v.callback_at IS NULL AND (o.lead_locked_by IS NULL OR o.lead_locked_at < NOW() - ($2 || ' minutes')::interval)
       ORDER BY o.created_at ASC LIMIT $1 FOR UPDATE OF o SKIP LOCKED)
     UPDATE orders_master o SET assigned_to = 'InHouse', assigned_agent = NULL, updated_at = NOW()
     FROM pick WHERE o.id = pick.id RETURNING o.id, o.order_name`, [n, String(LOCK_MINUTES)]);
  for (const r of rows) {
    await db(`SELECT log_status_change($1, 'reassigned', 'CC', 'InHouse', $2, 'Moved to in-house team to balance the workload')`, [r.id, who]);
  }
  return rows;
}

// Migration 004 adds orders_master.requeued_at. Until it is applied, re-queueing is refused instead of guessing.
let hasCol = false;
async function hasRequeueColumn(db) {
  if (hasCol) return true;
  const r = await db(`SELECT 1 FROM information_schema.columns WHERE table_name = 'orders_master' AND column_name = 'requeued_at'`);
  hasCol = r.length > 0;
  return hasCol;
}

module.exports = { counts, moveLeads, hasRequeueColumn, LOCK_MINUTES };
