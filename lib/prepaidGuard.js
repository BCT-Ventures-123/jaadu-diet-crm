// A COD order may only become prepaid before it ships. Returns a reason string when it is too late, else null.
const SHIPPED_STATES = ['shipped', 'delivered', 'ndr', 'rto', 'lost', 'returned'];

function shippingLocked(order) {
  if (!order) return null;
  if (SHIPPED_STATES.includes(order.order_status)) return `order is ${order.order_status}`;
  if (order.awb_number) return 'courier AWB already assigned';
  if (order.shipped_at) return 'order already shipped';
  return null;
}

module.exports = { shippingLocked, SHIPPED_STATES };
