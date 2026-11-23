const defaultConfig = require('./riskConfig');

function validPhone(p) {
  const s = String(p || '');
  if (!/^[6-9]\d{9}$/.test(s)) return false;
  if (/^(\d)\1{9}$/.test(s)) return false;
  return true;
}

// lead: order row. ctx: { pincode: {shipped, rto}, customer: {priorRtos}, recentOrders }
function scoreRisk(lead, ctx = {}, config = defaultConfig) {
  let points = 0;
  const reasons = [];
  const add = (p, why) => { points += p; reasons.push(why); };

  // 1. Pincode RTO history from our own orders
  const pin = ctx.pincode || {};
  const shipped = Number(pin.shipped) || 0;
  const rto = Number(pin.rto) || 0;
  if (shipped >= config.pincodeRto.minShipped) {
    const rate = rto / shipped;
    const pctText = `${Math.round(rate * 100)}% RTO in PIN ${lead.shipping_zip} (${rto}/${shipped})`;
    if (rate >= config.pincodeRto.highRate) add(config.pincodeRto.highPoints, pctText);
    else if (rate >= config.pincodeRto.mediumRate) add(config.pincodeRto.mediumPoints, pctText);
  }

  // 2. Address completeness
  const zip = String(lead.shipping_zip || '').trim();
  if (!/^\d{6}$/.test(zip)) add(config.address.badPinPoints, 'PIN code missing or invalid');
  const addr = [lead.shipping_address1, lead.shipping_address2].filter(Boolean).join(' ').trim();
  if (addr.length < config.address.minChars) add(config.address.shortPoints, 'Address is short');
  if (!config.address.landmarkWords.test(addr)) add(config.address.missingLandmarkPoints, 'No landmark or house/area detail');

  // 3. Customer's previous refusals / RTOs
  const priorRtos = Number((ctx.customer || {}).priorRtos) || 0;
  if (priorRtos >= 2) add(config.customerHistory.twoOrMorePoints, `${priorRtos} earlier RTO/refused orders`);
  else if (priorRtos === 1) add(config.customerHistory.onePoints, '1 earlier RTO/refused order');

  // 4. Repeat orders in a short time
  const recent = Number(ctx.recentOrders) || 0;
  if (recent >= 2) add(config.repeatOrders.twoOrMorePoints, `${recent} other orders from this number in ${config.repeatOrders.windowHours}h`);
  else if (recent === 1) add(config.repeatOrders.onePoints, `Another order from this number in ${config.repeatOrders.windowHours}h`);

  // 5. Order value
  const value = Number(lead.total_price) || 0;
  if (value >= config.orderValue.highValue) add(config.orderValue.highPoints, `High order value (Rs ${value})`);
  else if (value >= config.orderValue.mediumValue) add(config.orderValue.mediumPoints, `Higher order value (Rs ${value})`);

  // 6. Phone validity
  if (!validPhone(lead.customer_phone)) add(config.phone.invalidPoints, 'Phone number looks invalid');

  const level = points >= config.levels.high ? 'High' : points >= config.levels.medium ? 'Medium' : 'Low';
  return { level, points, reasons: reasons.length ? reasons : ['No warning signs found'] };
}

// Batch-load history context for many leads with 3 queries.
async function loadRiskContext(dbFn, leads) {
  const zips = [...new Set(leads.map(l => l.shipping_zip).filter(Boolean))];
  const phones = [...new Set(leads.map(l => l.customer_phone).filter(Boolean))];
  const ids = leads.map(l => l.id);

  const pinRows = zips.length ? await dbFn(`
    SELECT shipping_zip,
      COUNT(*) FILTER (WHERE order_status IN ('shipped','in_transit','delivered','ndr','rto','lost')) AS shipped,
      COUNT(*) FILTER (WHERE order_status = 'rto') AS rto
    FROM orders_master WHERE shipping_zip = ANY($1) GROUP BY shipping_zip`, [zips]) : [];

  const custRows = phones.length ? await dbFn(`
    SELECT o.id AS order_id,
      (SELECT COUNT(*) FROM orders_master p
        WHERE p.customer_phone = o.customer_phone AND p.id <> o.id AND p.created_at < o.created_at
          AND (p.order_status = 'rto' OR p.rto_status IS NOT NULL OR p.ndr_last_reason ILIKE '%refus%')) AS prior_rtos,
      (SELECT COUNT(*) FROM orders_master r
        WHERE r.customer_phone = o.customer_phone AND r.id <> o.id
          AND r.created_at BETWEEN o.created_at - ($3 || ' hours')::interval AND o.created_at) AS recent_orders
    FROM orders_master o WHERE o.id = ANY($1) AND o.customer_phone = ANY($2)`,
    [ids, phones, String(defaultConfig.repeatOrders.windowHours)]) : [];

  const pinMap = new Map(pinRows.map(r => [r.shipping_zip, { shipped: Number(r.shipped), rto: Number(r.rto) }]));
  const custMap = new Map(custRows.map(r => [r.order_id, { priorRtos: Number(r.prior_rtos), recentOrders: Number(r.recent_orders) }]));
  return { pinMap, custMap };
}

async function attachRisk(dbFn, leads, config = defaultConfig) {
  if (!leads.length) return leads;
  const { pinMap, custMap } = await loadRiskContext(dbFn, leads);
  return leads.map(l => {
    const c = custMap.get(l.id) || {};
    const r = scoreRisk(l, {
      pincode: pinMap.get(l.shipping_zip),
      customer: { priorRtos: c.priorRtos },
      recentOrders: c.recentOrders,
    }, config);
    return { ...l, risk_level: r.level, risk_points: r.points, risk_reasons: r.reasons };
  });
}

module.exports = { scoreRisk, attachRisk, validPhone };
