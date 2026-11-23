const test = require('node:test');
const assert = require('node:assert/strict');
const sb = require('../lib/sheetBackup');

const base = { order_name: '#40001', created_at: '2026-11-20T01:00:00Z', payment_method: 'COD', total_price: '599', confirmation_status: 'pending' };

test('backup sheet: one row per order shows each channel and who finished it', () => {
  const a = sb.toRow({ ...base, confirmation_status: 'confirmed', ivr_result: 'confirmed', fin_actor: 'ivr_call', aman_disp: 'dnp', aman_n: 2 }, 'x');
  assert.deepEqual(a.slice(0, 7), ['#40001', '2026-11-20', 'COD', 599, 'Confirmed', 'IVR', 'DNP']);
  assert.equal(a[10], 'Confirmed');
  const b = sb.toRow({ ...base, confirmation_status: 'confirmed', fin_actor: 'Priya', fin_role: 'agent', cc_disp: 'confirmed', cc_n: 3 }, 'x');
  assert.equal(b[5], 'Call centre'); assert.equal(b[8], 'Confirmed'); assert.equal(b[9], 3);
  const c = sb.toRow({ ...base, confirmation_status: 'confirmed', fin_actor: 'Aman', fin_role: 'aman' }, 'x'); assert.equal(c[5], 'Aman');
  const w = sb.toRow({ ...base, confirmation_status: 'confirmed', fin_actor: 'whatsapp_late', wa_event: 'confirmed' }, 'x'); assert.equal(w[5], 'WhatsApp'); assert.equal(w[11], 'Confirmed');
  assert.equal(a.length, 14); assert.equal(a[12], 'x'); assert.equal(a[13], '');                                         // column N (WhatsApp Messages) comes after Updated
});

test('backup sheet: main status of orders still open', () => {
  assert.equal(sb.toRow({ ...base, aman_disp: 'dnp', aman_last_at: '2026-11-20T05:00:00Z' }, 'x')[4], 'DNP');
  assert.equal(sb.toRow({ ...base, cc_disp: 'callback', cc_last_at: '2026-11-20T06:00:00Z', aman_disp: 'dnp', aman_last_at: '2026-11-20T05:00:00Z' }, 'x')[4], 'Callback');
  assert.equal(sb.toRow(base, 'x')[4], 'Pending');
  assert.equal(sb.toRow({ ...base, confirmation_status: 'cancelled' }, 'x')[4], 'Cancelled');
  assert.equal(sb.toRow({ ...base, ivr_status: 'placed' }, 'x')[10], 'Called, no key');
  assert.equal(sb.toRow({ ...base, ivr_result: 'cancel_requested' }, 'x')[10], 'Cancel asked (caller follows up)');
});

test('backup sheet: the month starts at midnight India time', () => {
  assert.equal(sb.monthStartIst(new Date('2026-11-20T08:00:00Z')).toISOString(), '2026-10-31T18:30:00.000Z');
  assert.equal(sb.monthStartIst(new Date('2026-11-30T19:00:00Z')).toISOString(), '2026-11-30T18:30:00.000Z'); // already 1 Dec in India
});

test('backup sheet: only real COD tea orders are selected (Rs 350 or more)', () => {
  const sql = sb.buildSql(true);
  assert.match(sql, /COALESCE\(o\.total_price, 0\) >= 350/); assert.match(sql, /= 'COD'/); assert.match(sql, /ivr_calls/);
  assert.doesNotMatch(sb.buildSql(false), /ivr_calls/);
});

test('backup sheet: settings tolerate spaces, quotes and capitals; on by default', () => {
  assert.equal(sb.settings({}).on, true); assert.equal(sb.settings({ BACKUP_SHEET: ' "OFF" ' }).on, false);
  assert.equal(sb.settings({}).sheetId, sb.DEFAULT_SHEET_ID); assert.equal(sb.settings({ BACKUP_SHEET_ID: ' abc ' }).sheetId, 'abc');
});

function fakeSheets({ haveTabs = [], reportMark = null } = {}) {
  const calls = [];
  const tabs = new Map(haveTabs.map((t, i) => [t, i + 1]));
  const api = {
    calls,
    spreadsheets: {
      get: async () => ({ data: { sheets: [...tabs].map(([title, sheetId]) => ({ properties: { title, sheetId } })) } }),
      batchUpdate: async (a) => { calls.push(['batch', a.requestBody.requests.map(r => Object.keys(r)[0])]); const replies = []; for (const r of a.requestBody.requests) if (r.addSheet) { const id = 100 + tabs.size; tabs.set(r.addSheet.properties.title, id); replies.push({ addSheet: { properties: { title: r.addSheet.properties.title, sheetId: id } } }); } else replies.push({}); return { data: { replies } }; },
      values: {
        get: async () => ({ data: { values: reportMark ? [[reportMark]] : undefined } }),
        update: async (a) => { calls.push(['update', a.range, a.requestBody.values.length]); return {}; },
        clear: async (a) => { calls.push(['clear', a.range]); return {}; },
      },
    },
  };
  return api;
}

test('backup sheet: run writes the rows, clears the leftovers below, and builds the Report tab once', async () => {
  const db = async (sql) => (/to_regclass/.test(sql) ? [{ t: null }] : [{ ...base, confirmation_status: 'confirmed', fin_actor: 'Aman', fin_role: 'aman' }, { ...base, order_name: '#40002' }]);
  const sheets = fakeSheets();
  const r = await sb.run({ db, sheets, sheetId: 'S', now: new Date('2026-11-20T08:00:00Z') });
  assert.equal(r.rows, 2); assert.equal(r.report_created, true);
  const up = sheets.calls.find(c => c[0] === 'update' && /CRM Status/.test(c[1])); assert.equal(up[2], 3);                 // header + 2 rows
  assert.deepEqual(sheets.calls.find(c => c[0] === 'clear'), ['clear', "'CRM Status'!A4:N"]);
  assert.ok(sheets.calls.some(c => c[0] === 'batch' && c[1].includes('addSheet')));
  const again = fakeSheets({ haveTabs: ['CRM Status', 'Report'], reportMark: 'Confirmation report v1' });
  const r2 = await sb.run({ db, sheets: again, sheetId: 'S' });
  assert.equal(r2.report_created, false); assert.ok(!again.calls.some(c => c[0] === 'batch'));                           // nothing rebuilt when the Report already exists
});

test('backup sheet: a database error is thrown to the caller and nothing is written', async () => {
  const sheets = fakeSheets({ haveTabs: ['CRM Status', 'Report'] });
  await assert.rejects(() => sb.run({ db: async (s) => { if (/to_regclass/.test(s)) return [{ t: 1 }]; throw new Error('boom'); }, sheets, sheetId: 'S' }), /boom/);
  assert.equal(sheets.calls.length, 0);
});

test('backup sheet: the Report formulas point at the right rows', () => {
  const v = sb.reportValues();
  assert.equal(v[2][0], 'Period'); assert.equal(v[3][0], 'From'); assert.equal(v[4][0], 'To'); assert.equal(v[6][0], 'COD orders in this period');
  assert.equal(v[7][0], 'Confirmed'); assert.equal(v[11][0], 'Who finished the orders'); assert.equal(v[12][0], 'Aman'); assert.equal(v[16][0], 'Old sheet / other'); assert.equal(v[17][0], 'Total');
  assert.match(v[7][1], /COUNTIFS\('CRM Status'!\$B:\$B,">="&\$B\$4,'CRM Status'!\$B:\$B,"<="&\$B\$5,'CRM Status'!\$E:\$E,"Confirmed"\)/);
  assert.match(v[12][1], /\$F:\$F,"Aman",'CRM Status'!\$E:\$E,"Confirmed"/);
});


test('backup sheet: the WhatsApp column says what happened, and the message count is in column N', () => {
  assert.equal(sb.toRow({ ...base, wa_msgs: 2 }, 'x')[11], 'Sent, no reply'); assert.equal(sb.toRow({ ...base, wa_msgs: 2 }, 'x')[13], 2);
  assert.equal(sb.toRow({ ...base, wa_msgs: 1, wa_click: 'clicked_cancel' }, 'x')[11], 'Cancel asked (caller follows up)');
  assert.equal(sb.toRow({ ...base, wa_msgs: 1, wa_click: 'clicked_change_address' }, 'x')[11], 'Change address asked');
  assert.equal(sb.toRow({ ...base, wa_msgs: 3, wa_click: 'replied_text' }, 'x')[11], 'Replied (caller follows up)');
  assert.equal(sb.toRow({ ...base, confirmation_status: 'confirmed', wa_event: 'confirmed', wa_msgs: 1, wa_click: 'clicked_cancel' }, 'x')[11], 'Confirmed');        // a decision beats a later tap
  assert.equal(sb.toRow(base, 'x')[11], ''); assert.equal(sb.toRow(base, 'x')[13], '');
  assert.match(sb.buildSql(true, true), /wa_messages/); assert.match(sb.buildSql(true, true), /wa_events/); assert.doesNotMatch(sb.buildSql(true, false), /wa_messages/);
});

test('backup sheet: last month stays in the tab until the sheet script says it has mailed it, and the CRM tells the script it is there', async () => {
  const seen = [];
  const db = async (sql, p) => { if (/to_regclass/.test(sql)) return [{ t: null }]; seen.push(p && p[0]); return [{ ...base }]; };
  const mk = (configRows) => { const s = fakeSheets({ haveTabs: ['CRM Status', 'Report'], reportMark: 'Confirmation report v1' }); s.spreadsheets.values.get = async (a) => ({ data: { values: /Config/.test(a.range) ? configRows : [['Confirmation report v1']] } }); return s; };
  const now = new Date('2026-11-23T08:00:00Z');
  const a = mk([['Key', 'Value'], ['START_DATE', '2026-11-01']]);                                                 // nothing mailed yet: October is still wanted
  const ra = await sb.run({ db, sheets: a, sheetId: 'S', now });
  assert.equal(ra.includes_previous_month, true); assert.equal(seen[0], '2026-09-30T18:30:00.000Z');              // the query starts on 1 October India time
  assert.ok(a.calls.some(c => c[0] === 'update' && c[1] === 'Config!A3:B3'));                                      // INCLUDES 2026-10 written on the first free row
  const b = mk([['Key', 'Value'], ['START_DATE', '2026-11-01'], ['LAST_MAILED_MONTH', 'MAILED 2026-10']]);        // October was mailed: back to this month only
  const rb = await sb.run({ db, sheets: b, sheetId: 'S', now });
  assert.equal(rb.includes_previous_month, false); assert.equal(seen[1], '2026-10-31T18:30:00.000Z');
  assert.equal(sb.monthKeyIst(sb.prevMonthStartIst(new Date('2026-01-05T08:00:00Z'))), '2025-12');                // January looks back to December of the year before
});