// IVR Solutions connection (stage 2). Places one voice call per lead from an approved text template, and understands the key the customer presses.
// Pure helpers plus the HTTP call (the http client is passed in so tests never touch the network). The API token is read from the environment only and is never logged.
const crypto = require('crypto');

const BASE = 'https://api.ivrsolutions.in';
const DEFAULT_VARS = ['customer_name', 'amount', 'order_id'];
const tenDigits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const clean = (v, max = 60) => String(v == null ? '' : v).replace(/[,\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function settings(env = process.env) {
  return {
    apiKey: env.IVR_API_KEY || '',
    did: env.IVR_DID || '',                                 // the number calls go out from, e.g. +918044475798
    template: env.IVR_TEMPLATE || 'cod_confirm_open_v4',    // approved text template (variables: customer_name, amount, order_id)
    flowId: env.IVR_FLOW_ID || '',                          // call flow that plays the 1 / 2 / 3 menu
    webhookKey: env.IVR_WEBHOOK_KEY || '',                  // secret in the address the flow calls when a key is pressed
    varNames: String(env.IVR_VARIABLE_NAMES || DEFAULT_VARS.join(',')).split(',').map(x => x.trim()).filter(Boolean),   // the template's variable names, in order
    testNumbers: String(env.IVR_TEST_NUMBERS || '').split(/[,\s;]+/).map(tenDigits).filter(x => x.length === 10),
  };
}

// What is still missing before a call can be placed (names only, never values).
function missing(s) {
  const m = [];
  if (!s.apiKey) m.push('IVR_API_KEY'); if (!s.did) m.push('IVR_DID'); if (!s.flowId) m.push('IVR_FLOW_ID');
  if (!s.webhookKey) m.push('IVR_WEBHOOK_KEY'); if (!s.testNumbers.length) m.push('IVR_TEST_NUMBERS');
  return m;
}

// Template variables are sent comma separated, in the order the template lists them, so commas inside a value are removed.
const buildVariables = ({ name, amount, orderId }) => [clean(name || 'Customer', 40), clean(amount, 12), clean(orderId, 20)].join(',');
const dialNumber = (p) => '0' + tenDigits(p);                // the API wants the number with a 0 in front

const KEYS = { '1': 'confirmed', '2': 'address_change', '3': 'cancel_requested' };
const mapKey = (dtmf) => KEYS[String(dtmf == null ? '' : dtmf).trim()] || 'unknown';
const MEANING = { confirmed: 'Pressed 1: confirmed', address_change: 'Pressed 2: wants to change the address', cancel_requested: 'Pressed 3: wants to cancel', unknown: 'Pressed an unknown key' };

// The IVR may send its own call id and the customer's number under different names; take whichever is there.
const first = (o, names) => { for (const n of names) { const k = Object.keys(o || {}).find(x => x.toLowerCase() === n); if (k && String(o[k]).trim()) return String(o[k]).trim(); } return ''; };
const pickCallId = (o) => first(o, ['call_id', 'callid', 'call_uuid', 'uuid', 'logid', 'call_log_id', 'id']);
const pickPhone = (o) => tenDigits(first(o, ['customer_no', 'customer_number', 'customer', 'phone', 'mobile', 'caller', 'caller_id', 'cli', 'number', 'from', 'to', 'msisdn']));

const safeEqual = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

// Remove the secret before anything is stored.
const withoutSecret = (o) => { const r = {}; for (const k of Object.keys(o || {})) if (!/^(key|token|secret|authorization)$/i.test(k)) r[k] = String(o[k]).slice(0, 300); return r; };

// One call. Returns { ok, callId, message }. Never throws on an API error: the caller records the failure.
async function dialByText({ phone, name, amount, orderId, settings: s = settings(), http }) {
  if (!s.apiKey || !s.did || !s.flowId) return { ok: false, message: 'IVR is not set up: ' + missing(s).join(', ') };
  const client = http || require('axios');
  try {
    // The docs show one comma separated "Variable" string, but the service checks the template's named variables (customer_name, amount, order_id),
    // so both forms are sent: the named values and the comma separated string.
    const values = [clean(name || 'Customer', 40), clean(amount, 12), clean(orderId, 20)];
    const named = {}; (s.varNames || DEFAULT_VARS).forEach((n, i) => { if (n && values[i] !== undefined) named[n] = values[i]; });
    const res = await client.post(BASE + '/api/dial_by_text', {
      did_no: s.did, customer_no: dialNumber(phone), template_name: s.template, flow_id: String(s.flowId), Variable: buildVariables({ name, amount, orderId }), ...named,
    }, { headers: { Authorization: 'Bearer ' + s.apiKey, 'Content-Type': 'application/json' }, timeout: 15000 });
    const d = res.data || {};
    const ok = Number(d.status) === 200 || (res.status >= 200 && res.status < 300 && d.status === undefined);
    return { ok, callId: String(d.call_id || d.logid || d.id || ''), message: String(d.message || (ok ? 'Call initiated' : 'Not accepted')).slice(0, 200) };
  } catch (err) {
    const d = err.response && err.response.data;
    return { ok: false, message: String((d && (d.message || d.error)) || err.message || 'Request failed').slice(0, 200) };
  }
}

module.exports = { BASE, settings, missing, tenDigits, clean, buildVariables, dialNumber, mapKey, MEANING, pickCallId, pickPhone, safeEqual, withoutSecret, dialByText };
