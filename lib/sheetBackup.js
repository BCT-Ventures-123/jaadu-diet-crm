// Backup copy of the CRM's results in the "Updated Caller sheet" (Google Sheets). One row per COD order of the current month (plus orders still waiting), with who did what:
// Main result, who finished it, Aman, Call centre, IVR, WhatsApp. A "Report" tab counts them by channel for a chosen period. The CRM stays the master; this only READS the database.
// The tab is rewritten every 5 minutes, so last month disappears from it by itself on the 1st (the monthly email + clean-up of the Orders tab is a separate sheet script).
const DEFAULT_SHEET_ID = '1dY4IY1fkq8TJ2U_dF7izo3DJF3NNpzYUzyzF2UM2SBo';
const TAB = 'CRM Status', REPORT = 'Report', MARK = 'Confirmation report v1';
// Column N (WhatsApp Messages) comes AFTER Updated on purpose: the Report formulas and the sheet script read columns A to M by position.
const HEAD = ['Order', 'Order Date', 'Payment', 'Amount', 'Main Disposition', 'Finished By', 'Aman', 'Aman Tries', 'Call Centre', 'Call Centre Tries', 'IVR', 'WhatsApp', 'Updated', 'WhatsApp Messages'];
const LAST_COL = 'N';
const products = require('./products');
const MIN_AMOUNT = products.MIN_PRICE;   // orders under Rs 350 are not real COD tea orders
// The SAME rules as the Home report (cc_routes.js fetchCohortRows), so the sheet and the CRM count the same orders: given to Aman or the call centre, COD and not converted to prepaid, not a test order, a real tea product.
const TEST_NAME = `(LOWER(TRIM(COALESCE(o.customer_name,''))) IN ('test test','test','test order','dummy') OR COALESCE(o.customer_name,'') ~* '^\\s*test\\M')`;
const ITEMS = `(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)`;

function settings(env = process.env) {
  const v = String(env.BACKUP_SHEET || 'on').trim().replace(/^["']|["']$/g, '').toLowerCase();
  return { on: !['off', 'false', '0', 'no'].includes(v), sheetId: String(env.BACKUP_SHEET_ID || DEFAULT_SHEET_ID).trim().replace(/^["']|["']$/g, '') };
}

const DISP = { confirmed: 'Confirmed', cancelled: 'Cancelled', dnp: 'DNP', callback: 'Callback', address_fix: 'Address fixed', wrong_number: 'Wrong number', dnc: 'Do not call', escalated: 'Escalated' };
const disp = (d) => (d ? DISP[String(d).toLowerCase()] || String(d) : '');
const istDate = (t) => (t ? new Date(new Date(t).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) : '');
const istStamp = (t) => (t ? new Date(new Date(t).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
const monthStartIst = (now = new Date()) => { const d = new Date(new Date(now).getTime() + 5.5 * 3600e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 5.5 * 3600e3); };
const prevMonthStartIst = (now = new Date()) => monthStartIst(new Date(monthStartIst(now).getTime() - 86400e3));
const monthKeyIst = (d) => istDate(d).slice(0, 7);

function ivrText(r) {
  const res = String(r.ivr_result || '').toLowerCase(), st = String(r.ivr_status || '').toLowerCase();
  if (res === 'confirmed') return 'Confirmed';
  if (res === 'address_change') return 'Address change';
  if (res === 'cancel_requested') return 'Cancel asked (caller follows up)';
  if (st === 'failed' || st === 'failed_system') return 'Call failed';
  if (st === 'skipped') return 'Left to a person';
  if (st === 'placed' || st === 'answered') return 'Called, no key';
  return '';
}

// What WhatsApp did on this order: the decision it made, else what the customer tapped or wrote (a caller follows up), else that messages went out and nobody replied.
function waText(r) {
  if (r.wa_event) return disp(r.wa_event);
  const c = String(r.wa_click || '');
  if (c === 'clicked_cancel') return 'Cancel asked (caller follows up)';
  if (c === 'clicked_change_address') return 'Change address asked';
  if (c === 'replied_text') return 'Replied (caller follows up)';
  return Number(r.wa_msgs) > 0 ? 'Sent, no reply' : '';
}

function finishedBy(r) {
  const a = String(r.fin_actor || '').toLowerCase();
  if (!a) return '';
  if (a === 'whatsapp' || a === 'whatsapp_late') return 'WhatsApp';
  if (a === 'ivr_call' || a === 'ivr_late' || a === 'ivr') return 'IVR';
  if (a === 'sheet') return 'Old sheet';
  if (r.fin_role === 'aman') return 'Aman';
  if (r.fin_role === 'agent') return 'Call centre';
  if (r.fin_role === 'admin') return 'Admin';
  return 'Other';
}

function mainText(r) {
  const s = String(r.confirmation_status || 'pending').toLowerCase();
  if (s === 'confirmed') return 'Confirmed';
  if (s === 'cancelled') return 'Cancelled';
  const last = String(r.cc_last_at || '') > String(r.aman_last_at || '') ? r.cc_disp : r.aman_disp;
  if (last === 'dnp') return 'DNP';
  if (last === 'callback') return 'Callback';
  return 'Pending';
}

function toRow(r, nowStamp) {
  return [r.order_name || '', istDate(r.created_at), String(r.payment_method || 'COD').toUpperCase(), Number(r.total_price) || 0, mainText(r), finishedBy(r),
    disp(r.aman_disp), r.aman_n ? Number(r.aman_n) : '', disp(r.cc_disp), r.cc_n ? Number(r.cc_n) : '', ivrText(r),
    waText(r), nowStamp, Number(r.wa_msgs) > 0 ? Number(r.wa_msgs) : ''];
}

function buildSql(withIvr, withWa) {
  return `SELECT o.order_name, COALESCE(o.shopify_created_at, o.created_at) AS created_at, o.payment_method, o.total_price, o.confirmation_status,
    a1.disposition AS aman_disp, a1.n AS aman_n, a1.last_at AS aman_last_at, c1.disposition AS cc_disp, c1.n AS cc_n, c1.last_at AS cc_last_at,
    wa.event_type AS wa_event, fin.actor AS fin_actor, fin.role AS fin_role${withIvr ? ', iv.result AS ivr_result, iv.status AS ivr_status' : ''}${withWa ? ', wc.wa_click, wm.n AS wa_msgs' : ''}
  FROM orders_master o
  LEFT JOIN LATERAL (SELECT l.disposition, l.created_at AS last_at, count(*) OVER ()::int AS n FROM lead_call_log l JOIN agents a ON a.id = l.agent_id
      WHERE l.order_id = o.id AND a.role = 'aman' AND l.disposition <> 'note' ORDER BY l.created_at DESC LIMIT 1) a1 ON TRUE
  LEFT JOIN LATERAL (SELECT l.disposition, l.created_at AS last_at, count(*) OVER ()::int AS n FROM lead_call_log l JOIN agents a ON a.id = l.agent_id
      WHERE l.order_id = o.id AND a.role = 'agent' AND l.disposition <> 'note' ORDER BY l.created_at DESC LIMIT 1) c1 ON TRUE
  LEFT JOIN LATERAL (SELECT e.event_type FROM order_status_events e WHERE e.order_id = o.id AND e.actor IN ('whatsapp', 'whatsapp_late')
      AND e.event_type IN ('confirmed', 'cancelled') ORDER BY e.created_at DESC LIMIT 1) wa ON TRUE
  LEFT JOIN LATERAL (SELECT e.actor, ag.role FROM order_status_events e LEFT JOIN agents ag ON ag.display_name = e.actor
      WHERE e.order_id = o.id AND e.event_type IN ('confirmed', 'cancelled') ORDER BY e.created_at DESC LIMIT 1) fin ON TRUE
  ${withIvr ? `LEFT JOIN LATERAL (SELECT i.result, i.status FROM ivr_calls i WHERE i.order_id = o.id AND NOT i.is_test AND i.status <> 'skipped'
      ORDER BY (i.result IS NOT NULL) DESC, i.placed_at DESC LIMIT 1) iv ON TRUE` : ''}
  ${withWa ? `LEFT JOIN LATERAL (SELECT e.event AS wa_click FROM wa_events e WHERE e.order_id = o.id AND e.event IN ('clicked_cancel', 'clicked_change_address', 'replied_text') ORDER BY e.at DESC NULLS LAST LIMIT 1) wc ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM wa_messages w WHERE w.order_id = o.id AND NOT w.is_test AND w.sent_at IS NOT NULL) wm ON TRUE` : ''}
  WHERE (COALESCE(o.shopify_created_at, o.created_at) >= $1 OR o.confirmation_status = 'pending') AND UPPER(COALESCE(o.payment_method, 'COD')) = 'COD' AND COALESCE(o.total_price, 0) >= ${MIN_AMOUNT}
    AND o.assigned_to IN ('CC', 'InHouse') AND COALESCE(o.converted_to_prepaid, FALSE) = FALSE AND NOT ${TEST_NAME}
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(${ITEMS}) li, unnest($2::text[]) p WHERE starts_with(COALESCE(li->>'title',''), p))
  ORDER BY COALESCE(o.shopify_created_at, o.created_at)`;
}

// since = where the list starts. Normally the first of this month; while last month has not been mailed yet (see run) it is the first of last month.
async function readRows(db, now, since) {
  const has = async (name) => { try { const t = await db(`SELECT to_regclass('${name}') AS t`); return !!(t && t[0] && t[0].t); } catch (e) { return false; } };
  const withIvr = await has('ivr_calls'), withWa = (await has('wa_messages')) && (await has('wa_events'));
  const rows = await db(buildSql(withIvr, withWa), [(since || monthStartIst(now)).toISOString(), products.ALLOWED_PREFIXES]);
  const stamp = istStamp(now);
  return rows.map(r => toRow(r, stamp));
}

// ---- the Report tab (formulas, so it keeps itself up to date) ----
function reportValues() {
  const S = `'${TAB}'!`, d = `${S}$B:$B`, inRange = `${d},">="&$B$4,${d},"<="&$B$5`;
  const cnt = (extra) => `=COUNTIFS(${inRange}${extra ? ',' + extra : ''})`;
  const fin = (ch, main) => cnt(`${S}$F:$F,"${ch}",${S}$E:$E,"${main}"`);
  const ch = ['Aman', 'Call centre', 'IVR', 'WhatsApp'];
  const rows = [
    [MARK, '', '', '', ''],
    ['Pick a period in B3. For your own dates choose "Custom dates" and type them in E4 and E5.', '', '', '', ''],
    ['Period', 'Today', '', '', ''],
    ['From', '=IF(B3="Custom dates",E4,CHOOSE(MATCH(B3,{"Today","Last 2 days","Last 4 days","Last 7 days","This month"},0),TODAY(),TODAY()-1,TODAY()-3,TODAY()-6,DATE(YEAR(TODAY()),MONTH(TODAY()),1)))', '', 'Custom from', '=TODAY()'],
    ['To', '=IF(B3="Custom dates",E5,TODAY())', '', 'Custom to', '=TODAY()'],
    ['', '', '', '', ''],
    ['COD orders in this period', cnt(''), '', '', ''],
    ['Confirmed', cnt(`${S}$E:$E,"Confirmed"`), '=IFERROR(B8/B7,0)', '', ''],
    ['Cancelled', cnt(`${S}$E:$E,"Cancelled"`), '=IFERROR(B9/B7,0)', '', ''],
    ['DNP / callback / pending', '=B7-B8-B9', '=IFERROR(B10/B7,0)', '', ''],
    ['', '', '', '', ''],
    ['Who finished the orders', 'Confirmed', 'Cancelled', 'Share of confirmed', ''],
    ...ch.map((c, i) => [c, fin(c, 'Confirmed'), fin(c, 'Cancelled'), `=IFERROR(B${13 + i}/$B$8,0)`, '']),
    ['Old sheet / other', `=B8-SUM(B13:B16)`, `=B9-SUM(C13:C16)`, '=IFERROR(B17/$B$8,0)', ''],
    ['Total', '=SUM(B13:B17)', '=SUM(C13:C17)', '', ''],
    ['', '', '', '', ''],
    ['IVR calls in this period', 'Orders', '', '', ''],
    ['Pressed 1 (confirmed)', cnt(`${S}$K:$K,"Confirmed"`), '', '', ''],
    ['Pressed 2 (address change)', cnt(`${S}$K:$K,"Address change"`), '', '', ''],
    ['Pressed 3 (cancel asked, caller follows up)', cnt(`${S}$K:$K,"Cancel asked*"`), '', '', ''],
    ['Called, no key pressed', cnt(`${S}$K:$K,"Called, no key"`), '', '', ''],
  ];
  return rows;
}

async function ensureTabs(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties(sheetId,title)' });
  const have = new Map((meta.data.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
  const add = [TAB, REPORT].filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title } } }));
  if (add.length) {
    const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: add } });
    (r.data.replies || []).forEach(x => { if (x.addSheet) have.set(x.addSheet.properties.title, x.addSheet.properties.sheetId); });
  }
  return have;
}

async function ensureReport(sheets, sheetId, ids) {
  let cur = null;
  try { cur = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${REPORT}!A1` })).data.values; } catch (e) { cur = null; }
  if (cur && cur[0] && cur[0][0] === MARK) return false;
  await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${REPORT}!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: reportValues() } });
  const rid = ids.get(REPORT);
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [
    { setDataValidation: { range: { sheetId: rid, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 },
      rule: { condition: { type: 'ONE_OF_LIST', values: ['Today', 'Last 2 days', 'Last 4 days', 'Last 7 days', 'This month', 'Custom dates'].map(v => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true } } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 13 } } }, fields: 'userEnteredFormat.textFormat' } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 11, endRowIndex: 12 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 17, endRowIndex: 18 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 3, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd mmm yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 3, endRowIndex: 5, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: { sheetId: rid, startRowIndex: 7, endRowIndex: 17, startColumnIndex: 2, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { updateDimensionProperties: { range: { sheetId: rid, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 330 }, fields: 'pixelSize' } },
  ] } });
  return true;
}

// Write the CRM Status tab. The new rows are written first, then any leftover old rows below them are cleared, so the sheet is never empty while it refreshes.
// The "Config" tab of the sheet is shared with the sheet script. LAST_MAILED_MONTH ("MAILED 2026-10") is written by the script after it has emailed a finished month; CRM_INCLUDES_MONTH ("INCLUDES 2026-10")
// is written here to tell the script that last month's results are in the CRM Status tab, so the email is complete. Text with a prefix, so Google Sheets never turns it into a date.
async function configRead(sheets, sheetId) {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Config!A1:B40' });
    const m = new Map();
    ((r.data && r.data.values) || []).forEach((x, i) => { const k = String((x && x[0]) || '').trim(); if (k) m.set(k, { row: i + 1, value: String((x && x[1]) || '').trim() }); });
    return m;
  } catch (e) { return new Map(); }
}
async function configWrite(sheets, sheetId, cfg, key, value) {
  try {
    const cur = cfg.get(key);
    if (cur && cur.value === value) return;
    let row = cur ? cur.row : 2;
    if (!cur) { const used = new Set([...cfg.values()].map(v => v.row)); while (used.has(row)) row++; }
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `Config!A${row}:B${row}`, valueInputOption: 'RAW', requestBody: { values: [[key, value]] } });
  } catch (e) { console.error('[Backup sheet] could not write the Config tab:', e.message); }
}

async function run({ db, sheets, sheetId, now = new Date(), lastCount = 0 }) {
  const cfg = await configRead(sheets, sheetId);
  const prev = monthKeyIst(prevMonthStartIst(now)), mailed = ((cfg.get('LAST_MAILED_MONTH') || {}).value || '');
  const includePrev = !mailed.endsWith(prev);                  // last month stays in the tab until the sheet script has mailed it (then it drops out within 5 minutes)
  const rows = await readRows(db, now, includePrev ? prevMonthStartIst(now) : null);
  const ids = await ensureTabs(sheets, sheetId);
  const values = [HEAD, ...rows];
  await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `'${TAB}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `'${TAB}'!A${values.length + 1}:${LAST_COL}` });
  const made = await ensureReport(sheets, sheetId, ids);
  await configWrite(sheets, sheetId, cfg, 'CRM_INCLUDES_MONTH', includePrev ? 'INCLUDES ' + prev : '');
  return { rows: rows.length, report_created: made, includes_previous_month: includePrev };
}

module.exports = { settings, run, readRows, toRow, waText, reportValues, buildSql, monthStartIst, prevMonthStartIst, monthKeyIst, istDate, TAB, REPORT, HEAD, MIN_AMOUNT, DEFAULT_SHEET_ID };
