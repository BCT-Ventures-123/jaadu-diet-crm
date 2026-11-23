const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'cc_routes.js'), 'utf8');

// A person who has the customer on the phone must always be able to confirm, even if the IVR or WhatsApp holds the lead.
test('lock: an IVR or WhatsApp hold never blocks a person from saving the result', () => {
  const i = src.indexOf("throw new HttpError(409, `Lead is being handled by");
  assert.ok(i > 0);
  const cond = src.slice(src.lastIndexOf('if (order.lead_locked_by', i), i);
  assert.match(cond, /order\.lead_locked_by !== 'IVR'/);
  assert.match(cond, /order\.lead_locked_by !== 'WHATSAPP'/);
  assert.match(cond, /order\.lead_locked_by !== agent\.display_name/);       // another person still blocks
});

test('lock: opening a lead held by the IVR or WhatsApp takes it over, only while the order is pending', () => {
  const i = src.indexOf("app.post('/api/cc/lead/lock'");
  assert.ok(i > 0);
  const body = src.slice(i, i + 3200);
  assert.match(body, /lockedBy === 'IVR' \|\| lockedBy === 'WHATSAPP'/);
  assert.match(body, /lead_locked_by IN \('IVR', 'WHATSAPP'\) AND confirmation_status = 'pending'/);
  assert.match(body, /took_over_from/);
});


test('lock: the older lock route used by Aman\'s screen also lets a person take over an IVR or WhatsApp hold', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = srv.indexOf("app.post('/api/lead/lock'");
  assert.ok(i > 0);
  const body = srv.slice(i, i + 2600);
  assert.match(body, /lead_locked_by IN \('IVR', 'WHATSAPP'\) AND confirmation_status = 'pending'/);
  assert.match(body, /res\.json\(\{ locked \}\)/);
  assert.doesNotMatch(srv.slice(srv.indexOf("app.post('/api/lead/disposition'"), srv.indexOf("app.post('/api/lead/disposition'") + 2500), /being handled by/);   // saving a result is never blocked by a hold
});

test('one owner per lead: the IVR hold hides a lead from the call centre list and from Aman\'s list', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const hide = /NOT \(COALESCE\(o\.lead_locked_by, ''\) IN \('IVR', 'WHATSAPP'\) AND COALESCE\(o\.lead_locked_at > NOW\(\) - INTERVAL '15 minutes', FALSE\)\)/;
  const around = (text, marker) => { const i = text.indexOf(marker); assert.ok(i > 0, marker); return text.slice(i, i + 1300); };
  assert.match(around(srv, "app.get('/api/aman/fresh-leads'"), hide);
  assert.match(around(srv, "app.get('/api/cc/fresh-leads'"), hide);
  assert.match(around(src, "app.get('/api/cc/fresh-leads'"), hide);
});

test('one owner per lead: a person cannot take over a lead while its IVR call is still in progress, in either lock route', () => {
  const body = (text, marker) => { const i = text.indexOf(marker); assert.ok(i > 0, marker); return text.slice(i, i + 2600); };
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const b of [body(src, "app.post('/api/cc/lead/lock'"), body(srv, "app.post('/api/lead/lock'")]) {
    assert.match(b, /FROM ivr_calls WHERE order_id = \$1 AND NOT is_test AND status = 'placed' AND result IS NULL AND placed_at > NOW\(\) - INTERVAL '3 minutes'/);
  }
  assert.match(body(src, "app.post('/api/cc/lead/lock'"), /The IVR is calling this customer right now/);
});

test('Shopify: a confirmation from the call-centre screen is tagged on Shopify at once, and the status route exists', () => {
  assert.match(src, /disposition === 'confirmed' && typeof syncConfirmedTag === 'function'/);
  assert.match(src, /app\.get\('\/api\/cc\/shopify-sync'/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(srv, /updateShopifyShippingAddress, syncConfirmedTag \}\);/);
});