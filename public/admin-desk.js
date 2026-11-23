/* Admin "Money & Risk" tabs: Refunds, Courier money, Blacklist, Pincodes. Uses helpers from admin.html ($, esc, fmt, api, table, today). */
(function () {
  var tabsEl = $('tabs');
  var anchorPane = $('p-log');
  var add = function (key, label, html) {
    var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = key; t.textContent = label; tabsEl.appendChild(t);
    var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-' + key; p.innerHTML = html; anchorPane.parentNode.appendChild(p);
    t.onclick = function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active'); p.classList.add('active'); (LOADERS[key] || function () {})();
    };
  };
  var LOADERS = {};
  var money = function (n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
  var fail = function (e) { if (e && e.message !== 'login' && e.message !== 'forbidden') alert(e.message); };
  var card = function (v, l, cls) { return '<div class="card"><div class="v ' + (cls || '') + '">' + v + '</div><div class="l">' + l + '</div></div>'; };

  // ------------------------------------------------------------------ REFUNDS
  var zcss = document.createElement('style');
  zcss.textContent =
    '.zsub{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border)}.zst{padding:10px 16px;cursor:pointer;color:var(--muted);font-size:0.75rem;font-weight:600;border-bottom:2px solid transparent}' +
    '.zst.active{color:var(--ds-info);border-bottom-color:var(--ds-info)}.zb{display:inline-block;padding:3px 10px;border-radius:999px;font-size:0.75rem;font-weight:700;text-transform:uppercase;background:var(--surface2);color:var(--muted)}' +
    '.zb.captured{background:rgba(16,185,129,.15);color:var(--ds-brand)}.zb.refunded{background:rgba(139,92,246,.18);color:var(--ds-brand)}.zb.partial{background:rgba(245,158,11,.16);color:var(--ds-warn-ink)}' +
    '.zb.failed{background:rgba(239,68,68,.16);color:var(--ds-danger)}.zb.method{background:rgba(16,185,129,.12);color:var(--ds-brand)}.zmono{font-family:ui-monospace,Consolas,monospace;font-size:0.75rem;color:var(--muted)}' +
    '.zbulk{display:flex;justify-content:space-between;align-items:center;background:var(--ds-info);color:#fff;border-radius:12px;padding:14px 20px;margin-bottom:14px;font-size:0.875rem}' +
    '.zbtn{border:none;border-radius:9px;padding:8px 16px;font-weight:700;font-size:0.75rem;cursor:pointer;font-family:inherit;margin-left:8px}.zbtn.ghost{background:rgba(255,255,255,.25);color:#fff}.zbtn.white{background:#fff;color:var(--ds-danger)}' +
    '.zbtn.blue{background:var(--ds-info);color:#fff}.zbtn.small{background:var(--surface2);color:var(--text);border:1px solid var(--border);padding:6px 14px;margin:0}.zbtn:disabled{opacity:.5;cursor:not-allowed}' +
    '.zov{position:fixed;inset:0;background:rgba(5,10,24,.8);z-index:500;display:flex;align-items:center;justify-content:center}.zmod{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:92%;max-width:560px;max-height:88vh;display:flex;flex-direction:column}' +
    '.zmod h3{margin:0;padding:18px 24px;font-size:1rem;color:var(--text);border-bottom:1px solid var(--border);display:flex;justify-content:space-between}.zmod .zl{overflow:auto;padding:16px 24px;display:flex;flex-direction:column;gap:10px}' +
    '.zr{background:var(--surface2);border-radius:10px;padding:12px 16px;display:flex;gap:12px;align-items:flex-start}.zr .ic{font-size:1rem;font-weight:800}.zr.ok .ic{color:var(--ds-brand)}.zr.bad .ic{color:var(--ds-danger)}.zr b{display:block;font-size:0.875rem}.zr span{font-size:0.75rem;color:var(--muted)}';
  document.head.appendChild(zcss);
  var rangeSel = function (id) { return '<select id="' + id + '"><option value="0">Today</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>'; };
  var ZP_HTML =
    '<div class="zsub"><span class="zst active" data-sub="crm">Refunds</span><span class="zst" data-sub="hist">Refund History</span></div>' +
    '<div id="rfp-pay" style="display:none"><div class="cards" id="zp-cards"></div>' +
    '<div class="filters"><div style="flex:1;min-width:240px"><label>Search</label><input id="zp-q" placeholder="Search by phone, email, order ID, payment ID…" style="width:100%"></div>' +
    '<div><label>Status</label><select id="zp-status"><option value="">All Statuses</option><option value="refundable">Refundable</option><option value="captured">Captured</option><option value="partial">Partly refunded</option><option value="refunded">Refunded</option><option value="failed">Failed</option><option value="authorized">Authorized</option><option value="created">Created</option></select></div>' +
    '<div><label>Method</label><select id="zp-method"><option value="">All Methods</option><option value="upi">UPI</option><option value="card">Card</option><option value="netbanking">Netbanking</option><option value="wallet">Wallet</option><option value="emi">EMI</option><option value="paylater">Pay later</option></select></div>' +
    '<div><label>Min ₹</label><input id="zp-min" type="number" style="width:90px"></div><div><label>Max ₹</label><input id="zp-max" type="number" style="width:90px"></div>' +
    '<div><label>Period</label>' + rangeSel('zp-range') + '</div><button class="zbtn blue" id="zp-go" style="margin:0">Refresh</button></div>' +
    '<div id="zp-bulk"></div><div class="tw"><table id="zp-table"></table></div><div class="muted" id="zp-note" style="margin-bottom:18px"></div></div>' +
    '<div id="rfp-hist" style="display:none"><div class="filters"><div><label>Period</label>' + rangeSel('zh-range') + '</div><button class="zbtn blue" id="zh-go" style="margin:0">Refresh</button></div>' +
    '<div class="cards" id="zh-cards"></div><div class="tw"><table id="zh-table"></table></div></div>';

  add('refunds', 'Refunds', ZP_HTML + '<div id="rfp-crm">' +
    '<div id="rfs"><div class="filters"><div><label>Period</label>' + rangeSel('rfs-range') + '</div><button class="zbtn blue" id="rfs-go" style="margin:0">Refresh</button><span class="muted" id="rfs-sub"></span></div>' +
    '<div class="cards" id="rfs-cards"></div><div id="rfs-body"></div></div>' +
    '<div class="msg">Refund money to a customer. <b>Refund via Razorpay</b> sends the money back automatically to the customer\'s original payment. ' +
    '<b>Mark refunded manually</b> is for when you sent it yourself (UPI/bank) and just want it recorded.</div>' +
    '<h3>1. Find the order to refund</h3>' +
    '<div class="filters"><div><label>From date</label><input type="date" id="ro-from"></div>' +
    '<div><label>To date</label><input type="date" id="ro-to"></div>' +
    '<div><label>Order / phone / name</label><input id="ro-q" placeholder="e.g. #23127"></div>' +
    '<div><label>Order amount up to ₹</label><input id="ro-max" type="number" placeholder="e.g. 500" style="width:110px"></div>' +
    '<div><label>Order status</label><select id="ro-status"><option value="">All</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option><option value="pending">Pending</option></select></div>' +
    '<div><label>Payment</label><select id="ro-pay"><option value="">All</option><option value="COD">COD</option><option value="Prepaid">Prepaid</option></select></div>' +
    '<button class="btn alt" id="ro-500">Under ₹500</button><button class="btn" id="ro-go">Search</button></div>' +
    '<div id="ro-bulk"></div><div class="tw"><table id="ro-table"></table></div><div id="ro-pager" style="display:flex;justify-content:center;align-items:center;gap:12px;margin:12px 0"></div>' +
    '<div style="display:flex;align-items:center;gap:12px;margin:18px 0 6px">' +
    '<button class="btn alt" id="ro-cleanup" style="font-size:0.75rem">Cleanup bad payment IDs</button><span id="ro-bf-status" class="muted"></span></div>' +
    '<h3>2. Refund requests</h3>' +
    '<div class="filters"><div><label>Status</label><select id="rf-status"><option value="">All</option><option value="pending">Waiting</option><option value="approved">In progress</option><option value="processed">Done</option><option value="rejected">Rejected</option></select></div>' +
    '<div><label>Refund up to ₹</label><input id="rf-max" type="number" style="width:110px"></div>' +
    '<div><label>Search</label><input id="rf-q" placeholder="order / phone / name"></div>' +
    '<div><label>Requested from</label><input type="date" id="rf-from"></div><div><label>to</label><input type="date" id="rf-to"></div>' +
    '<div><label>Reason contains</label><input id="rf-reason" placeholder="e.g. cancelled" style="width:130px"></div>' +
    '<div><label>Method</label><select id="rf-method"><option value="">All</option><option value="razorpay">Razorpay</option><option value="manual_upi">Manual UPI</option></select></div>' +
    '<div><label>Requested by</label><input id="rf-by" style="width:110px"></div>' +
    '<div><label>Order</label><select id="rf-sort"><option value="">Newest first</option><option value="age">Oldest first</option></select></div>' +
    '<button class="btn" id="rf-go">Apply</button><a class="btn alt" id="rf-csv" href="#">Export CSV</a></div>' +
    '<div id="rf-bulk"></div><div class="tw"><table id="rf-table"></table></div></div>');

  var RF_STATUS = { pending: 'Waiting', approved: 'In progress', processed: 'Done', rejected: 'Rejected' };
  function roQuery() { return 'q=' + encodeURIComponent($('ro-q').value) + '&max_amount=' + encodeURIComponent($('ro-max').value) + '&from=' + $('ro-from').value + '&to=' + $('ro-to').value + '&status=' + $('ro-status').value + '&pay_method=' + $('ro-pay').value; }
  function rfQuery() { return 'status=' + $('rf-status').value + '&max_amount=' + encodeURIComponent($('rf-max').value) + '&q=' + encodeURIComponent($('rf-q').value) + '&from=' + $('rf-from').value + '&to=' + $('rf-to').value + '&reason=' + encodeURIComponent($('rf-reason').value) + '&method=' + $('rf-method').value + '&by=' + encodeURIComponent($('rf-by').value) + '&sort=' + $('rf-sort').value; }
  var roSel = {}, roRows = {}, roAllRows = [], roPage = 1, RO_PER = 15;
  function roBulk() {
    var ids = Object.keys(roSel), total = ids.reduce(function (s, i) { return s + roSel[i].paid; }, 0);
    $('ro-bulk').innerHTML = ids.length ? '<div class="zbulk"><span><b>' + ids.length + '</b> order(s) selected &nbsp;|&nbsp; Total paid: <b>' + money(total) + '</b></span>' +
      '<span><button class="zbtn ghost" id="ro-clear">Clear</button><button class="zbtn white" id="ro-bulkref">Bulk Refund Selected</button></span></div>' : '';
  }
  function roRenderPage() {
    var totalPages = Math.ceil(roAllRows.length / RO_PER) || 1;
    if (roPage > totalPages) roPage = totalPages;
    var start = (roPage - 1) * RO_PER, pageRows = roAllRows.slice(start, start + RO_PER);
    $('ro-table').innerHTML = '<thead><tr><th><input type="checkbox" id="ro-all"></th>' +
      '<th>Order date</th><th>Order</th><th>Customer</th><th>Phone</th><th>Paid</th><th>Status</th><th>Payment</th><th>Already refunded</th><th>Open request</th><th>Razorpay payment</th><th>Action</th></tr></thead><tbody>' +
      pageRows.map(function (r) {
        var paid = Number(r.prepaid_amount) > 0 ? Number(r.prepaid_amount) : Number(r.total_price);
        return '<tr><td><input type="checkbox" class="ro-ck" data-id="' + esc(r.id) + '" data-paid="' + paid + '"' + (roSel[r.id] ? ' checked' : '') + '></td>' +
          '<td>' + esc(fmt(r.order_date)) + '</td><td>' + esc(r.order_name || r.shopify_order_id) + '</td>' +
          '<td>' + esc(r.customer_name) + '</td><td>' + esc(r.customer_phone) + '</td>' +
          '<td>' + money(paid) + '</td><td><span class="badge">' + esc(r.confirmation_status || '') + '</span></td>' +
          '<td>' + esc(r.payment_method || '') + '</td><td>' + money(r.refunded) + '</td><td>' + money(r.requested_open) + '</td>' +
          '<td>' + esc(r.razorpay_payment_id || '— (auto on refund)') + '</td>' +
          '<td>' + (Number(r.refunded) >= paid ? '<span class="badge" style="background:#27ae60">Refunded</span>' : '<button class="btn sm" data-ro="' + esc(r.id) + '" data-name="' + esc(r.order_name || '') + '">Refund…</button>') + '</td></tr>';
      }).join('') + '</tbody>';
    $('ro-pager').innerHTML = totalPages > 1 ? '<button class="btn alt sm" id="ro-prev"' + (roPage <= 1 ? ' disabled' : '') + '>&larr; Previous</button>' +
      '<span style="font-size:0.875rem;color:var(--muted)">Page ' + roPage + ' of ' + totalPages + ' (' + roAllRows.length + ' orders)</span>' +
      '<button class="btn alt sm" id="ro-next"' + (roPage >= totalPages ? ' disabled' : '') + '>Next &rarr;</button>' : '<span class="muted" style="font-size:0.875rem">' + roAllRows.length + ' orders</span>';
    roBulk();
  }
  async function loadRefundOrders() {
    loading('ro-table', 'Loading orders…'); $('ro-pager').innerHTML = '';
    var rows = await api('/api/admin/refund-orders?' + roQuery());
    roSel = {}; roRows = {}; roAllRows = rows; roPage = 1;
    rows.forEach(function (r) { roRows[r.id] = r; });
    if (!rows.length) { $('ro-table').innerHTML = '<tbody><tr><td class="empty">No paid orders match. Only orders paid online can be refunded.</td></tr></tbody>'; $('ro-pager').innerHTML = ''; roBulk(); return; }
    roRenderPage();
  }
  var rfSel = {};
  function rfBulk() {
    var ids = Object.keys(rfSel), total = ids.reduce(function (s, i) { return s + (rfSel[i].amount || 0); }, 0);
    $('rf-bulk').innerHTML = ids.length ? '<div class="bar">' + ids.length + ' request(s) selected | Total: ' + money(total) +
      '<span><button class="zbtn ghost" id="rf-clear">Clear</button><button class="zbtn white" id="rf-bulkgw">Bulk Refund via Razorpay</button></span></div>' : '';
  }
  async function loadRefunds() {
    loading('rf-table', 'Loading refund requests…');
    var rows = await api('/api/admin/refunds?' + rfQuery());
    rfSel = {};
    if (!rows.length) { $('rf-table').innerHTML = '<tbody><tr><td class="empty">No refund requests</td></tr></tbody>'; rfBulk(); return; }
    $('rf-table').innerHTML = '<thead><tr><th><input type="checkbox" id="rf-all"></th>' +
      '<th>Requested</th><th>Age</th><th>Order</th><th>Customer</th><th>Phone</th><th>Refund</th><th>Reason</th><th>Status</th><th>Refund ID / UTR</th><th>Note</th><th>Action</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var canRefund = r.status === 'pending';
        return '<tr><td>' + (canRefund ? '<input type="checkbox" class="rf-ck" data-id="' + esc(r.id) + '" data-amount="' + Number(r.refund_amount) + '">' : '') + '</td>' +
          '<td>' + esc(fmt(r.created_at)) + '</td><td' + ((r.status === 'pending' || r.status === 'approved') && r.age_hours > rfSla ? ' style="color:var(--ds-danger);font-weight:700"' : '') + '>' + ageText(r.age_hours) + '</td><td>' + esc(r.order_name || r.shopify_order_id) + '</td>' +
          '<td>' + esc(r.customer_name) + '</td><td>' + esc(r.customer_phone) + '</td>' +
          '<td>' + money(r.refund_amount) + '</td><td class="wrap">' + esc(r.refund_reason || '') + '</td>' +
          '<td><span class="badge">' + esc(RF_STATUS[r.status] || r.status) + '</span></td>' +
          '<td>' + esc(r.utr_number || '') + '</td><td class="wrap">' + esc(r.notes || '') + '</td>' +
          '<td>' + (r.status === 'processed' || r.status === 'rejected' ? '' :
            (canRefund ? '<button class="btn sm" data-gw="' + esc(r.id) + '">Refund via Razorpay</button> ' : '') +
            '<button class="btn alt sm" data-mn="' + esc(r.id) + '">Mark refunded manually</button> ' +
            (canRefund ? '<button class="btn red sm" data-rj="' + esc(r.id) + '">Reject</button>' : '')) + '</td></tr>';
      }).join('') + '</tbody>';
    rfBulk();
  }
  var rfSla = 48;
  function ageText(h) { h = Number(h || 0); return h < 48 ? h + ' h' : Math.round(h / 24) + ' d'; }
  function addD(iso, k) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
  function miniTable(head, rows, empty) {
    return '<div class="tw"><table><thead><tr>' + head.map(function (h, i) { return '<th' + (i ? ' style="text-align:right"' : '') + '>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) { return '<tr>' + r.map(function (v, i) { return '<td' + (i ? ' style="text-align:right"' : '') + '>' + v + '</td>'; }).join('') + '</tr>'; }).join('') : '<tr><td colspan="' + head.length + '" class="empty">' + (empty || 'Nothing in this period') + '</td></tr>') + '</tbody></table></div>';
  }
  async function loadRefundSummary() {
    $('rfs-cards').innerHTML = '<div class="loading-row"><span class="spin"></span>Loading summary…</div>'; $('rfs-body').innerHTML = '';
    var days = Number($('rfs-range').value), to = today(), from = days === 0 ? to : addD(to, -(days - 1));
    var d = await api('/api/admin/refund-summary?from=' + from + '&to=' + to);
    rfSla = d.sla_hours; var k = d.kpi, a = d.ageing;
    $('rfs-sub').textContent = from + (from === to ? '' : ' to ' + to) + ' · refunds waiting longer than ' + d.sla_hours + ' hours are overdue';
    var oldest = k.oldest_open ? ageText(Math.round((Date.now() - new Date(k.oldest_open)) / 36e5)) : '—';
    $('rfs-cards').innerHTML =
      card(k.waiting_n, 'Waiting for you · ' + money(k.waiting_amt), k.waiting_n ? 'warn' : '') + card(oldest, 'Oldest open refund', a.overdue_n ? 'bad' : '') +
      card(a.overdue_n, 'Overdue (over ' + d.sla_hours + ' h) · ' + money(a.overdue_amt), a.overdue_n ? 'bad' : 'ok') + card(k.progress_n, 'In progress · ' + money(k.progress_amt)) +
      card(k.done_n, 'Refunded in period · ' + money(k.done_amt), 'ok') + card(k.requested_n, 'Requested in period · ' + money(k.requested_amt)) +
      card(k.rejected_n, 'Rejected in period') + card(k.avg_hours == null ? '—' : (k.avg_hours < 48 ? Math.round(k.avg_hours) + ' h' : Math.round(k.avg_hours / 24) + ' d'), 'Average time to refund') +
      card(d.stuck.n, 'Stuck (in progress over 1 h) · ' + money(d.stuck.amt), d.stuck.n ? 'bad' : 'ok') + card(d.owed.n, 'Cancelled prepaid, no refund raised · ' + money(d.owed.total), d.owed.n ? 'bad' : 'ok');
    var h = '<h3>Open refunds by age</h3>' + miniTable(['Age', 'Refunds', 'Amount'], [['Under 1 day', a.d0, money(a.a0)], ['1 to 3 days', a.d1, money(a.a1)], ['3 to 7 days', a.d3, money(a.a3)], ['Over 7 days', a.d7, money(a.a7)]]);
    if (d.owed.n) {
      h += '<h3>Money owed: prepaid orders cancelled with no refund raised (last 90 days)</h3><div class="msg">Please check the payment was actually captured before refunding. Total owed ' + money(d.owed.total) + ' on ' + d.owed.n + ' order(s)' + (d.owed.n > d.owed.rows.length ? ', showing the oldest ' + d.owed.rows.length : '') + '.</div>' +
        miniTable(['Order', 'Customer', 'Phone', 'Cancelled', 'Owed'], d.owed.rows.map(function (r) { return [esc(r.order_name), esc(r.customer_name), esc(r.customer_phone), esc(fmt(r.cancelled_at)), money(r.owed)]; }));
    }
    h += '<h3>By reason (requested in period)</h3>' + miniTable(['Reason', 'Refunds', 'Amount'], d.by_reason.map(function (r) { return [esc(r.reason), r.n, money(r.amt)]; }));
    h += '<h3>Paid out by method</h3>' + miniTable(['Method', 'Refunds', 'Amount'], d.by_method.map(function (r) { return [esc(r.method === 'manual_upi' ? 'Manual UPI' : r.method === 'razorpay' ? 'Razorpay' : r.method), r.n, money(r.amt)]; }));
    h += '<h3>Who requested / who processed</h3>' + miniTable(['Requested by', 'Refunds', 'Amount'], d.by_requested.map(function (r) { return [esc(r.who), r.n, money(r.amt)]; })) +
      '<div style="height:8px"></div>' + miniTable(['Processed by', 'Refunds', 'Amount'], d.by_processed.map(function (r) { return [esc(r.who), r.n, money(r.amt)]; }));
    h += '<h3>Day by day</h3>' + miniTable(['Date', 'Requested', 'Requested ₹', 'Paid out', 'Paid out ₹'], d.trend.map(function (r) { return [esc(r.day), r.requested, money(r.requested_amt), r.paid, money(r.paid_amt)]; }));
    $('rfs-body').innerHTML = h + '<h3>Refund requests</h3>';
  }
  $('rfs-go').onclick = function () { loadRefundSummary().catch(fail); };
  $('rfs-range').onchange = function () { loadRefundSummary().catch(fail); };
  LOADERS.refunds = function () { loadRefundSummary().catch(fail); loadRefundOrders().catch(fail); loadRefunds().catch(fail); };
  $('ro-go').onclick = function () { loadRefundOrders().catch(fail); };
  $('ro-500').onclick = function () { $('ro-max').value = 500; loadRefundOrders().catch(fail); };
  $('ro-pager').addEventListener('click', function (e) {
    if (e.target.id === 'ro-prev' && roPage > 1) { roPage--; roRenderPage(); $('ro-table').scrollIntoView({ behavior: 'smooth' }); }
    if (e.target.id === 'ro-next' && roPage < Math.ceil(roAllRows.length / RO_PER)) { roPage++; roRenderPage(); $('ro-table').scrollIntoView({ behavior: 'smooth' }); }
  });
  $('ro-cleanup').onclick = async function () {
    if (!confirm('This will clear invalid payment IDs (old backfill data). The correct ID will be fetched automatically when you click Refund. Continue?')) return;
    var st = $('ro-bf-status');
    $('ro-cleanup').disabled = true;
    try {
      var r = await api('/api/admin/cleanup-bad-payids', { method: 'POST' });
      st.textContent = 'Cleared ' + r.cleared + ' bad IDs. Refund will auto-fetch the correct one.';
      loadRefundOrders().catch(fail);
    } catch (e) { st.textContent = 'Error: ' + e.message; } finally { $('ro-cleanup').disabled = false; }
  };
  $('rf-go').onclick = function () { loadRefunds().catch(fail); };
  $('rf-csv').onclick = function (e) { e.preventDefault(); location.href = '/api/admin/refunds?format=csv&' + rfQuery(); };
  $('p-refunds').addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.ro) {
        var amt = prompt('How many rupees to refund for ' + (b.dataset.name || 'this order') + '?'); if (!amt) return;
        var why = prompt('Reason for the refund (required):'); if (!why) return;
        await api('/api/admin/refunds', { order_id: b.dataset.ro, amount: Number(amt), reason: why });
        LOADERS.refunds();
      } else if (b.dataset.gw) {
        if (!confirm('Send this refund to the customer through Razorpay now? This cannot be undone.')) return;
        b.disabled = true; var d = await api('/api/admin/refunds/' + b.dataset.gw + '/gateway', {});
        alert('Refund sent. Razorpay refund id: ' + d.refund_id); loadRefunds();
      } else if (b.dataset.mn) {
        var utr = prompt('Enter the UTR / transaction number of the refund you already sent:'); if (!utr) return;
        await api('/api/admin/refunds/' + b.dataset.mn + '/manual', { utr: utr }); loadRefunds();
      } else if (b.dataset.rj) {
        var n = prompt('Why are you rejecting this refund?'); if (n === null) return;
        await api('/api/admin/refunds/' + b.dataset.rj + '/reject', { notes: n }); loadRefunds();
      }
    } catch (err) { fail(err); loadRefunds().catch(function () {}); }
  });

  // Checkbox handlers for CRM refund orders
  $('p-refunds').addEventListener('change', function (e) {
    if (e.target.id === 'ro-all') {
      document.querySelectorAll('.ro-ck').forEach(function (c) {
        c.checked = e.target.checked;
        if (c.checked) roSel[c.dataset.id] = { paid: Number(c.dataset.paid) };
        else delete roSel[c.dataset.id];
      });
      roBulk();
    } else if (e.target.classList.contains('ro-ck')) {
      if (e.target.checked) roSel[e.target.dataset.id] = { paid: Number(e.target.dataset.paid) };
      else delete roSel[e.target.dataset.id];
      var all = $('ro-all'); if (all) { var cks = document.querySelectorAll('.ro-ck'); all.checked = cks.length > 0 && Array.prototype.every.call(cks, function (c) { return c.checked; }); }
      roBulk();
    }
  });
  $('ro-bulk').addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'ro-clear') {
      roSel = {}; document.querySelectorAll('.ro-ck,#ro-all').forEach(function (c) { c.checked = false; }); roBulk(); return;
    }
    if (b.id === 'ro-bulkref') {
      var ids = Object.keys(roSel); if (!ids.length) return;
      var total = ids.reduce(function (s, i) { return s + roSel[i].paid; }, 0);
      var details = ids.map(function (i) { var r = roRows[i]; return (r ? r.order_name : i) + ' → ' + money(roSel[i].paid); }).join('\n');
      var why = prompt('Reason for refunding these ' + ids.length + ' orders (required):\n\n' + details + '\n\nTotal: ' + money(total));
      if (!why) return;
      var typed = prompt('You are about to create ' + ids.length + ' FULL refund request(s) totalling ' + money(total) + '.\nEach order will be refunded its full paid amount.\n\nType REFUND to confirm:');
      if (typed !== 'REFUND') return;
      b.disabled = true; b.textContent = 'Processing…';
      var ok = 0, fail2 = 0;
      for (var i = 0; i < ids.length; i++) {
        try {
          await api('/api/admin/refunds', { order_id: ids[i], amount: roSel[ids[i]].paid, reason: why });
          ok++;
        } catch (err) { fail2++; }
        b.textContent = 'Processing ' + (i + 1) + '/' + ids.length + '…';
      }
      alert(ok + ' refund request(s) created' + (fail2 ? ', ' + fail2 + ' failed' : '') + '.\nGo to "2. Refund requests" below to approve and process them.');
      roSel = {}; LOADERS.refunds();
    }
  });

  // Checkbox handlers for Step 2 refund requests
  $('p-refunds').addEventListener('change', function (e) {
    if (e.target.id === 'rf-all') {
      document.querySelectorAll('.rf-ck').forEach(function (c) {
        c.checked = e.target.checked;
        if (c.checked) rfSel[c.dataset.id] = { amount: Number(c.dataset.amount) };
        else delete rfSel[c.dataset.id];
      });
      rfBulk();
    } else if (e.target.classList.contains('rf-ck')) {
      if (e.target.checked) rfSel[e.target.dataset.id] = { amount: Number(e.target.dataset.amount) };
      else delete rfSel[e.target.dataset.id];
      var all = $('rf-all'); if (all) { var cks = document.querySelectorAll('.rf-ck'); all.checked = cks.length > 0 && Array.prototype.every.call(cks, function (c) { return c.checked; }); }
      rfBulk();
    }
  });
  $('rf-bulk').addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'rf-clear') {
      rfSel = {}; document.querySelectorAll('.rf-ck,#rf-all').forEach(function (c) { c.checked = false; }); rfBulk(); return;
    }
    if (b.id === 'rf-bulkgw') {
      var ids = Object.keys(rfSel); if (!ids.length) return;
      var total = ids.reduce(function (s, i) { return s + rfSel[i].amount; }, 0);
      var typed = prompt('You are about to refund ' + ids.length + ' request(s) totalling ' + money(total) + ' via Razorpay.\nMoney goes back to customers\' original payment. Cannot be undone.\n\nType REFUND to confirm:');
      if (typed !== 'REFUND') return;
      b.disabled = true;
      var ok = 0, fail2 = 0, errors = [];
      for (var i = 0; i < ids.length; i++) {
        b.textContent = 'Processing ' + (i + 1) + '/' + ids.length + '…';
        try {
          await api('/api/admin/refunds/' + ids[i] + '/gateway', {});
          ok++;
        } catch (err) { fail2++; errors.push(err.message); }
      }
      alert(ok + ' refunded via Razorpay' + (fail2 ? ', ' + fail2 + ' failed' + (errors.length ? ': ' + errors[0] : '') : ''));
      rfSel = {}; LOADERS.refunds();
    }
  });

  // ---- Razorpay payments dashboard (Payments / Refund History) ----
  var ZSEL = {}, ZROWS = {};
  var zRange = function (id) {
    var d = Number($(id).value), t = today();
    var f = d <= 1 ? t : new Date(new Date(t + 'T12:00:00+05:30').getTime() - (d - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return 'from=' + f + '&to=' + t;
  };
  var zdate = function (s) { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }); };
  var zWho = function (p) { return p.email || p.phone || p.id; };
  var ZLABEL = { captured: 'Captured', refunded: 'Refunded', partial: 'Part refund', failed: 'Failed', created: 'Created', authorized: 'Authorized' };

  function zBulk() {
    var ids = Object.keys(ZSEL), total = ids.reduce(function (s, i) { return s + ZSEL[i]; }, 0);
    $('zp-bulk').innerHTML = ids.length ? '<div class="zbulk"><span><b>' + ids.length + '</b> payment(s) selected &nbsp;|&nbsp; Total: <b>' + money(total) + '</b></span>' +
      '<span><button class="zbtn ghost" id="zp-clear">Clear</button><button class="zbtn white" id="zp-refsel">Refund Selected</button></span></div>' : '';
    var all = $('zp-all'); if (all) { var ck = document.querySelectorAll('.zp-ck'); all.checked = ck.length > 0 && Array.prototype.every.call(ck, function (c) { return c.checked; }); }
  }
  async function loadPay(force) {
    loading('zp-table', 'Loading payments from Razorpay…');
    $('zp-note').textContent = 'Loading from Razorpay…';
    var q = '/api/admin/rzp/payments?' + zRange('zp-range') + '&q=' + encodeURIComponent($('zp-q').value) + '&status=' + $('zp-status').value + '&method=' + $('zp-method').value +
      '&min=' + encodeURIComponent($('zp-min').value) + '&max=' + encodeURIComponent($('zp-max').value) + (force ? '&refresh=1' : '');
    var d = await api(q), s = d.stats;
    ZSEL = {}; ZROWS = {}; d.rows.forEach(function (p) { ZROWS[p.id] = p; });
    $('zp-cards').innerHTML = card(s.total, 'Total payments') + card(s.captured, 'Captured (refundable)', 'ok') +
      '<div class="card"><div class="v" style="color:var(--ds-brand)">' + s.refunded + '</div><div class="l">Already refunded</div></div>' + card(money(s.captured_amount), 'Total amount');
    $('zp-note').textContent = 'Showing ' + d.rows.length + ' of ' + d.matched + ' matching payments (' + d.from + ' to ' + d.to + ').' +
      (d.truncated ? ' Razorpay returned more than 5000 payments; pick a shorter period to see all.' : '');
    var head = '<thead><tr><th><input type="checkbox" id="zp-all"></th><th>Date</th><th>Payment ID</th><th>Customer</th><th>Phone</th><th>Method</th><th>Amount</th><th>Status</th><th>CRM order</th><th>Action</th></tr></thead>';
    $('zp-table').innerHTML = d.rows.length ? head + '<tbody>' + d.rows.map(function (p) {
      var can = p.refundable > 0;
      return '<tr><td>' + (can ? '<input type="checkbox" class="zp-ck" data-id="' + esc(p.id) + '">' : '') + '</td><td>' + esc(zdate(p.created_at)) + '</td><td class="zmono">' + esc(p.id) + '</td>' +
        '<td><b>' + esc(p.email || '—') + '</b></td><td class="zmono">' + esc(p.phone) + '</td><td><span class="zb method">' + esc(p.method) + '</span></td>' +
        '<td><b>' + money(p.amount) + '</b>' + (p.refunded > 0 && p.status === 'partial' ? '<div class="muted" style="font-size:0.75rem">refunded ' + money(p.refunded) + '</div>' : '') + '</td>' +
        '<td><span class="zb ' + esc(p.status) + '" title="' + esc(p.error) + '">' + esc(ZLABEL[p.status] || p.status) + '</span></td><td>' + esc(p.crm_order) + '</td>' +
        '<td>' + (can ? '<button class="zbtn small" data-zr="' + esc(p.id) + '">Refund</button>' : '') + '</td></tr>';
    }).join('') + '</tbody>' : '<tbody><tr><td class="empty" colspan="10">No payments match</td></tr></tbody>';
    zBulk();
  }
  async function zRefund(id, amount, reason) {
    var p = ZROWS[id] || {};
    try { var d = await api('/api/admin/rzp/refund', { payment_id: id, amount: amount, reason: reason }); return { ok: true, who: zWho(p), refund_id: d.refund_id, amount: d.amount }; }
    catch (e) { return { ok: false, who: zWho(p), error: e.message }; }
  }
  function zResults(list) {
    var ov = document.createElement('div'); ov.className = 'zov';
    var okN = list.filter(function (r) { return r.ok; }).length;
    ov.innerHTML = '<div class="zmod"><h3><span>Refund Results <span class="muted" style="font-size:0.75rem;font-weight:500">(' + okN + ' of ' + list.length + ' done)</span></span><span style="cursor:pointer" id="zx">×</span></h3><div class="zl">' +
      list.map(function (r) {
        return '<div class="zr ' + (r.ok ? 'ok' : 'bad') + '"><div class="ic">' + (r.ok ? '✓' : '✗') + '</div><div><b>' + esc(r.who) + '</b><span>' +
          (r.ok ? 'Refund ID: ' + esc(r.refund_id) + ' | ' + money(r.amount) : esc(r.error)) + '</span></div></div>';
      }).join('') + '</div></div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); loadPay(true).catch(fail); };
    ov.querySelector('#zx').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  }
  $('rfp-pay').addEventListener('change', function (e) {
    if (e.target.id === 'zp-all') {
      document.querySelectorAll('.zp-ck').forEach(function (c) { c.checked = e.target.checked; if (c.checked) ZSEL[c.dataset.id] = ZROWS[c.dataset.id].refundable; else delete ZSEL[c.dataset.id]; });
      zBulk();
    } else if (e.target.classList.contains('zp-ck')) {
      if (e.target.checked) ZSEL[e.target.dataset.id] = ZROWS[e.target.dataset.id].refundable; else delete ZSEL[e.target.dataset.id];
      zBulk();
    }
  });
  $('rfp-pay').addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'zp-clear') { ZSEL = {}; document.querySelectorAll('.zp-ck,#zp-all').forEach(function (c) { c.checked = false; }); zBulk(); return; }
    if (b.dataset.zr) {
      var p = ZROWS[b.dataset.zr];
      var a = prompt('Refund how many rupees to ' + zWho(p) + '?\nLeave as it is for a full refund. Maximum ' + money(p.refundable) + '.', p.refundable); if (a === null) return;
      a = Number(a); if (!(a > 0) || a > p.refundable) { alert('Enter an amount between 1 and ' + p.refundable); return; }
      var why = prompt('Reason for the refund:', 'Customer refund'); if (why === null) return;
      b.disabled = true; zResults([await zRefund(p.id, a, why)]); return;
    }
    if (b.id === 'zp-refsel') {
      var ids = Object.keys(ZSEL); if (!ids.length) return;
      if (ids.length > 50) { alert('Select at most 50 payments at a time.'); return; }
      var total = ids.reduce(function (s, i) { return s + ZSEL[i]; }, 0);
      var typed = prompt('You are about to refund ' + ids.length + ' payment(s), ' + money(total) + ' in FULL, to the customers\' original payment method. This cannot be undone.\n\nType REFUND to continue:');
      if (typed !== 'REFUND') return;
      var reason = prompt('Reason for the refunds:', 'Customer refund'); if (reason === null) return;
      b.disabled = true; b.textContent = 'Refunding…';
      var out = [];
      for (var i = 0; i < ids.length; i++) { out.push(await zRefund(ids[i], ZSEL[ids[i]], reason)); b.textContent = 'Refunding ' + (i + 1) + '/' + ids.length + '…'; }
      zResults(out);
    }
  });
  $('zp-go').onclick = function () { loadPay(true).catch(fail); };
  $('zp-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadPay(false).catch(fail); });
  ['zp-status', 'zp-method', 'zp-range'].forEach(function (id) { $(id).onchange = function () { loadPay(false).catch(fail); }; });

  async function loadHist(force) {
    loading('zh-table', 'Loading refund history…');
    var d = await api('/api/admin/rzp/refunds?' + zRange('zh-range') + (force ? '&refresh=1' : ''));
    $('zh-cards').innerHTML = card(d.total, 'Refunds') + card(money(d.total_amount), 'Total refunded');
    table('zh-table', [['Date', function (r) { return zdate(r.created_at); }], ['Refund ID', function (r) { return r.id; }], ['Payment ID', function (r) { return r.payment_id; }],
      ['Amount', function (r) { return money(r.amount); }], ['Status', function (r) { return '<span class="zb ' + (r.status === 'processed' ? 'captured' : r.status === 'failed' ? 'failed' : '') + '">' + esc(r.status) + '</span>'; }, 0, 1],
      ['Speed', function (r) { return r.speed; }], ['Note', function (r) { return r.note; }, 1]], d.rows, 'No refunds in this period');
  }
  $('zh-go').onclick = function () { loadHist(true).catch(fail); };
  $('zh-range').onchange = function () { loadHist(false).catch(fail); };
  document.querySelectorAll('.zst').forEach(function (s) {
    s.onclick = function () {
      document.querySelectorAll('.zst').forEach(function (x) { x.classList.remove('active'); }); s.classList.add('active');
      ['pay', 'hist', 'crm'].forEach(function (k) { $('rfp-' + k).style.display = k === s.dataset.sub ? '' : 'none'; });
      if (s.dataset.sub === 'hist') loadHist(false).catch(fail);
      if (s.dataset.sub === 'crm') { loadRefundSummary().catch(fail); loadRefundOrders().catch(fail); loadRefunds().catch(fail); }
    };
  });

  // ------------------------------------------------------------------ COURIER MONEY
  add('courier', 'Courier money',
    '<div class="msg"><b>How this works:</b> delivered COD orders and RTOs come in <b>automatically</b> from the Shiprocket / Nimbus webhook. ' +
    'To see what the courier has <b>actually paid you</b> and the <b>weight charges</b>, download the COD remittance and weight-discrepancy reports from the Shiprocket / Nimbus dashboard and upload them below. ' +
    'The CRM matches them to your orders by AWB number.</div>' +
    '<div class="filters"><div><label>From (delivered / shipped)</label><input type="date" id="cm-from"></div><div><label>To</label><input type="date" id="cm-to"></div>' +
    '<button class="btn" id="cm-go">Apply</button><a class="btn alt" id="cm-pend" href="#">COD not received (7+ days) CSV</a><a class="btn alt" id="cm-wcsv" href="#">Weight disputes CSV</a></div>' +
    '<div class="cards" id="cm-cards"></div>' +
    '<h3>By courier</h3><div class="tw"><table id="cm-table"></table></div>' +
    '<h3>Weight charges by courier</h3><div class="tw"><table id="cm-weight"></table></div>' +
    '<h3>Upload a courier report</h3>' +
    '<div class="filters"><div><label>Report type</label><select id="up-type"><option value="remittance">COD remittance (money paid to you)</option><option value="weight">Weight discrepancy</option></select></div>' +
    '<div><label>Weight unit in file</label><select id="up-unit"><option value="kg">kg</option><option value="gm">grams</option></select></div>' +
    '<div><label>Courier name (optional)</label><input id="up-courier" placeholder="Shiprocket"></div>' +
    '<div><label>CSV file</label><input type="file" id="up-file" accept=".csv,text/csv"></div><button class="btn" id="up-go">Upload</button></div>' +
    '<div id="up-result"></div>' +
    '<h3>Weight disputes</h3><div class="tw"><table id="wd-table"></table></div>');

  function cmQuery() { return 'from=' + $('cm-from').value + '&to=' + $('cm-to').value; }
  async function loadCourier() {
    $('cm-cards').innerHTML = '<div class="loading-row"><span class="spin"></span>Loading courier data…</div>';
    loading('cm-table'); loading('cm-weight');
    var d = await api('/api/admin/courier/summary?' + cmQuery());
    $('cm-from').value = d.from; $('cm-to').value = d.to;
    var t = d.totals;
    $('cm-cards').innerHTML = card(t.shipped, 'Shipped') + card(t.delivered, 'Delivered') + card(t.rto, 'RTO') + card(money(t.cod_expected), 'COD to collect (delivered)') +
      card(money(t.cod_received), 'COD received', 'ok') + card(money(t.pending_amount), 'COD not received yet (' + t.pending_orders + ' orders)', t.pending_amount > 0 ? 'bad' : '') +
      card(money(t.short_amount), 'Short-paid (' + t.short_orders + ' orders)', t.short_amount > 0 ? 'bad' : '') + card(t.pending_over_7d, 'Unpaid over 7 days (all dates)', t.pending_over_7d > 0 ? 'bad' : '');
    table('cm-table', [['Courier', function (r) { return r.courier; }], ['Shipped', function (r) { return r.shipped; }], ['Delivered', function (r) { return r.delivered; }],
      ['RTO', function (r) { return r.rto; }], ['COD orders', function (r) { return r.cod_delivered; }], ['To collect', function (r) { return money(r.cod_expected); }],
      ['Received', function (r) { return money(r.cod_received); }], ['Not received', function (r) { return money(r.pending_amount) + ' (' + r.pending_orders + ')'; }],
      ['Short-paid', function (r) { return money(r.short_amount); }], ['Unpaid 7d+', function (r) { return r.pending_over_7d; }]], d.couriers, 'No courier activity in this period');
    table('cm-weight', [['Courier', function (r) { return r.courier; }], ['Disputes', function (r) { return r.disputes; }], ['Open', function (r) { return r.open; }],
      ['Extra grams', function (r) { return r.extra_gm; }], ['Excess charged', function (r) { return money(r.excess_total); }], ['Still open', function (r) { return money(r.excess_open); }]], d.weight, 'No weight disputes in this period');
    loadWeight().catch(fail);
  }
  async function loadWeight() {
    loading('wd-table', 'Loading weight disputes…');
    var rows = await api('/api/admin/courier/weight');
    table('wd-table', [['Found', function (r) { return fmt(r.created_at); }], ['Order', function (r) { return r.order_name || ''; }], ['AWB', function (r) { return r.awb_number; }],
      ['Courier', function (r) { return r.courier_name || ''; }], ['Charged (g)', function (r) { return r.weight_charged_gm; }], ['Actual (g)', function (r) { return r.weight_actual_gm; }],
      ['Extra (g)', function (r) { return r.weight_diff_gm; }], ['Excess ₹', function (r) { return r.excess_charge; }], ['Status', function (r) { return r.dispute_status; }],
      ['', function (r) {
        if (r.dispute_status.indexOf('resolved') === 0) return esc(r.resolution_notes || '');
        return '<button class="btn alt sm" data-wd="escalated" data-id="' + esc(r.id) + '">Raised with courier</button> <button class="btn sm" data-wd="resolved_favour" data-id="' + esc(r.id) + '">Won / refunded</button> <button class="btn red sm" data-wd="resolved_against" data-id="' + esc(r.id) + '">Lost</button>';
      }, 0, 1]], rows, 'No weight disputes yet. Upload a weight report above.');
  }
  LOADERS.courier = function () { loadCourier().catch(fail); };
  $('cm-go').onclick = LOADERS.courier;
  $('cm-pend').onclick = function (e) { e.preventDefault(); location.href = '/api/admin/courier/pending-cod?format=csv&older_than_days=7'; };
  $('cm-wcsv').onclick = function (e) { e.preventDefault(); location.href = '/api/admin/courier/weight?format=csv'; };
  $('p-courier').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-wd]'); if (!b) return;
    var notes = b.dataset.wd === 'escalated' ? 'Raised with courier' : prompt('Note (optional):') || '';
    try { await api('/api/admin/courier/weight/resolve', { id: b.dataset.id, status: b.dataset.wd, notes: notes }); loadWeight(); } catch (err) { fail(err); }
  });
  $('up-go').onclick = async function () {
    var f = $('up-file').files[0]; if (!f) { alert('Choose a CSV file first'); return; }
    var out = $('up-result'); out.innerHTML = '<div class="msg">Uploading…</div>';
    try {
      var r = await fetch('/api/admin/courier/import?type=' + $('up-type').value + '&unit=' + $('up-unit').value + '&courier=' + encodeURIComponent($('up-courier').value),
        { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await f.text() });
      var d = await r.json().catch(function () { return {}; });
      if (r.status === 401) { location.href = '/login.html?next=/admin.html'; return; }
      if (!r.ok) { out.innerHTML = '<div class="msg bad">' + esc(d.error || 'Upload failed') + '</div>'; return; }
      var lines = d.type === 'remittance'
        ? ['Rows in file: ' + d.rows_in_file, 'Matched to your COD orders: ' + d.matched, 'Total received: ' + money(d.total_received), 'Paid less than order value: ' + d.short_settled,
          'AWB not found in CRM: ' + d.unmatched_count + (d.unmatched_awbs.length ? ' (e.g. ' + d.unmatched_awbs.slice(0, 5).join(', ') + ')' : ''), 'Skipped (prepaid orders): ' + d.not_cod_count]
        : ['Rows in file: ' + d.rows_in_file, 'New disputes: ' + d.disputes_created, 'Updated: ' + d.disputes_updated, 'Total excess charged: ' + money(d.total_excess_charge),
          'AWB not found in CRM: ' + d.unmatched_count + (d.unmatched_awbs.length ? ' (e.g. ' + d.unmatched_awbs.slice(0, 5).join(', ') + ')' : '')];
      out.innerHTML = '<div class="msg">' + lines.map(esc).join('<br>') + '</div>';
      loadCourier().catch(fail);
    } catch (err) { out.innerHTML = '<div class="msg bad">' + esc(err.message) + '</div>'; }
  };

  // ------------------------------------------------------------------ BLACKLIST
  add('blacklist', 'Blacklist',
    '<div class="msg">New orders from a blacklisted <b>phone number</b> or <b>pincode</b> are flagged high-risk automatically (they go to the in-house team and are not shipped without a check).</div>' +
    '<div class="filters"><div><label>Type</label><select id="bl-type"><option value="phone">Phone number</option><option value="pincode">Pincode</option></select></div>' +
    '<div><label>Value</label><input id="bl-val" placeholder="10-digit phone or 6-digit pincode"></div>' +
    '<div><label>Reason</label><input id="bl-why" placeholder="e.g. 3 RTOs" style="width:220px"></div><button class="btn" id="bl-add">Add to blacklist</button></div>' +
    '<h3>Blacklisted phone numbers</h3><div class="tw"><table id="bl-phones"></table></div>' +
    '<h3>Blacklisted pincodes</h3><div class="tw"><table id="bl-pins"></table></div>' +
    '<h3>Suggested: customers with 2 or more RTO orders</h3><div class="tw"><table id="bl-sug"></table></div>');
  async function loadBlacklist() {
    loading('bl-phones', 'Loading blacklist…'); loading('bl-pins'); loading('bl-sug');
    var d = await api('/api/admin/blacklist');
    var rm = function (type, key) { return function (r) { return '<button class="btn alt sm" data-rm="' + type + '" data-v="' + esc(r[key]) + '">Remove</button>'; }; };
    table('bl-phones', [['Phone', function (r) { return r.phone; }], ['Reason', function (r) { return r.reason || ''; }, 1], ['Added by', function (r) { return r.added_by || ''; }], ['When', function (r) { return fmt(r.created_at); }], ['', rm('phone', 'phone'), 0, 1]], d.phones, 'No phone numbers blacklisted');
    table('bl-pins', [['Pincode', function (r) { return r.pincode; }], ['Reason', function (r) { return r.reason || ''; }, 1], ['Added by', function (r) { return r.added_by || ''; }], ['When', function (r) { return fmt(r.created_at); }], ['', rm('pincode', 'pincode'), 0, 1]], d.pincodes, 'No pincodes blacklisted');
    table('bl-sug', [['Phone', function (r) { return r.phone; }], ['Name', function (r) { return r.name || ''; }], ['Orders', function (r) { return r.orders; }], ['RTO', function (r) { return r.rto; }],
      ['', function (r) { return '<button class="btn red sm" data-sg="' + esc(r.phone) + '" data-why="' + esc(r.rto + ' RTO orders') + '">Blacklist</button>'; }, 0, 1]], d.suggestions, 'No suggestions');
  }
  LOADERS.blacklist = function () { loadBlacklist().catch(fail); };
  $('bl-add').onclick = async function () {
    try { await api('/api/admin/blacklist/add', { type: $('bl-type').value, value: $('bl-val').value, reason: $('bl-why').value }); $('bl-val').value = $('bl-why').value = ''; loadBlacklist(); } catch (e) { fail(e); }
  };
  $('p-blacklist').addEventListener('click', async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.rm) { if (!confirm('Remove from blacklist?')) return; await api('/api/admin/blacklist/remove', { type: b.dataset.rm, value: b.dataset.v }); loadBlacklist(); }
      if (b.dataset.sg) { await api('/api/admin/blacklist/add', { type: 'phone', value: b.dataset.sg, reason: b.dataset.why }); loadBlacklist(); }
    } catch (err) { fail(err); }
  });

  // ------------------------------------------------------------------ REPEAT CUSTOMERS
  add('repeat', 'Repeat customers',
    '<div class="msg"><b>How to read this:</b> a customer is one phone number. Each customer is placed in the month of their <b>first</b> order (their "cohort"). ' +
    '<b>Repeat %</b> = customers from that month who ordered again. <b>Within 30 days</b> etc. only count customers whose first order is at least that old, so recent months are not unfairly low. ' +
    'Test orders and orders under the minimum amount are left out.</div>' +
    '<div class="filters"><div><label>Count orders from</label><input type="date" id="rp-from" value="2026-06-03"></div>' +
    '<div><label>Ignore orders under ₹</label><input type="number" id="rp-min" value="500" style="width:90px"></div>' +
    '<div><label>Test phone numbers to ignore</label><input id="rp-tp" placeholder="comma separated" style="width:200px"></div>' +
    '<div><label>Ignore test orders</label><select id="rp-test"><option value="1">Yes (name has "test")</option><option value="0">No</option></select></div>' +
    '<div><label>Orders counted</label><select id="rp-del"><option value="0">All not-cancelled</option><option value="1">Delivered only</option></select></div>' +
    '<button class="btn" id="rp-go">Apply</button></div>' +
    '<div class="filters"><a class="btn alt" id="rp-c1" href="#">Cohorts CSV</a><a class="btn alt" id="rp-c2" href="#">By order month CSV</a><a class="btn alt" id="rp-c3" href="#">Repeat customers list CSV</a></div>' +
    '<div class="cards" id="rp-cards"></div>' +
    '<h3>Repeat rate by first-order month</h3><div class="tw"><table id="rp-cohort"></table></div>' +
    '<h3>Each month\'s orders: new vs returning customers</h3><div class="tw"><table id="rp-months"></table></div>' +
    '<h3>Repeat customers (top 300 by number of orders)</h3><div class="tw"><table id="rp-cust"></table></div>');
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var mname = function (m) { return MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); };
  var pc = function (v) { return v === null || v === undefined ? '—' : v + '%'; };
  function rpQuery() {
    return 'from=' + $('rp-from').value + '&min_amount=' + encodeURIComponent($('rp-min').value) + '&exclude_test=' + $('rp-test').value +
      '&only_delivered=' + $('rp-del').value + '&test_phones=' + encodeURIComponent($('rp-tp').value);
  }
  async function loadRepeat() {
    $('rp-cards').innerHTML = '<div class="loading-row"><span class="spin"></span>Loading repeat customers…</div>';
    loading('rp-cohort'); loading('rp-cust');
    var d = await api('/api/admin/repeat?' + rpQuery()), t = d.totals, f = d.filters;
    $('rp-cards').innerHTML = card(t.customers, 'Customers') + card(t.repeaters, 'Ordered again') + card(pc(t.repeat_pct), 'Repeat %', 'ok') +
      card(t.avg_days_to_second === null ? '—' : t.avg_days_to_second + ' days', 'Avg time to 2nd order') + card(t.orders_counted, 'Orders counted') +
      card(f.test_orders_excluded, 'Test orders ignored');
    table('rp-cohort', [['First order month', function (c) { return mname(c.month); }], ['Customers', function (c) { return c.customers; }], ['Ordered again', function (c) { return c.repeaters; }],
      ['Repeat %', function (c) { return pc(c.repeat_pct); }], ['Within 15 days', function (c) { return pc(c.within[15].pct); }], ['Within 30 days', function (c) { return pc(c.within[30].pct); }],
      ['Within 60 days', function (c) { return pc(c.within[60].pct); }], ['Within 90 days', function (c) { return pc(c.within[90].pct); }],
      ['Avg days to 2nd', function (c) { return c.avg_days_to_second === null ? '—' : c.avg_days_to_second; }], ['Repeat orders', function (c) { return c.repeat_orders; }],
      ['First-order ₹', function (c) { return money(c.first_revenue); }], ['Repeat ₹', function (c) { return money(c.repeat_revenue); }]], d.cohorts, 'No orders in this period');
    table('rp-months', [['Order month', function (m) { return mname(m.month); }], ['Orders', function (m) { return m.orders; }], ['New customers', function (m) { return m.new_customer_orders; }],
      ['Returning customers', function (m) { return m.returning_orders; }], ['Returning %', function (m) { return pc(m.returning_pct); }],
      ['Revenue', function (m) { return money(m.revenue); }], ['From returning', function (m) { return money(m.returning_revenue); }]], d.months, 'No orders in this period');
    table('rp-cust', [['Phone', function (c) { return c.phone; }], ['Name', function (c) { return c.name; }], ['Orders', function (c) { return c.orders; }], ['First order', function (c) { return c.first_order; }],
      ['Last order', function (c) { return c.last_order; }], ['Days to 2nd', function (c) { return c.days_to_second === null ? '' : c.days_to_second; }], ['Total spent', function (c) { return money(c.total_spent); }]],
      d.customers, 'No repeat customers yet');
  }
  LOADERS.repeat = function () { loadRepeat().catch(fail); };
  $('rp-go').onclick = LOADERS.repeat;
  [['rp-c1', 'cohorts'], ['rp-c2', 'months'], ['rp-c3', 'customers']].forEach(function (x) {
    $(x[0]).onclick = function (e) { e.preventDefault(); location.href = '/api/admin/repeat?format=csv&type=' + x[1] + '&' + rpQuery(); };
  });

  // ------------------------------------------------------------------ PINCODES
  add('pincodes', 'Ad-exclusion pincodes',
    '<div class="msg">Pincodes where many parcels come back (RTO). Download the CSV and upload it as an <b>exclusion list</b> in your ad account (Meta / Google) so you stop paying for ads there. ' +
    'It is built from shipped orders, so it fills up as the courier webhook reports RTOs.</div>' +
    '<div class="filters"><div><label>At least this many shipped</label><input id="pc-min" type="number" value="10" style="width:90px"></div>' +
    '<div><label>RTO % at least</label><input id="pc-pct" type="number" value="30" style="width:90px"></div>' +
    '<button class="btn" id="pc-go">Apply</button><a class="btn alt" id="pc-csv" href="#">Download CSV</a></div>' +
    '<div id="pc-health"></div><div class="tw"><table id="pc-table"></table></div>');
  var pcQ = function () { return 'min_shipped=' + $('pc-min').value + '&min_rto_pct=' + $('pc-pct').value; };
  async function loadPins() {
    loading('pc-table', 'Loading pincodes…');
    var d = await api('/api/admin/pincodes?' + pcQ());
    $('pc-health').innerHTML = '<div class="msg">Orders marked shipped / delivered / RTO: <b>' + d.health.shipped_orders + '</b>. Orders marked RTO: <b>' + d.health.rto_orders + '</b>.' +
      (d.health.rto_orders === 0 ? ' <span class="bad">No RTO orders are recorded yet, so this list will stay empty until the courier webhook marks returns.</span>' : '') + '</div>';
    table('pc-table', [['Pincode', function (r) { return r.pincode; }], ['Shipped', function (r) { return r.shipped; }], ['RTO', function (r) { return r.rto; }], ['RTO %', function (r) { return r.rto_pct + '%'; }],
      ['Blacklisted', function (r) { return r.blacklisted ? 'Yes' : ''; }]], d.rows, 'No pincodes match these limits');
  }
  LOADERS.pincodes = function () { loadPins().catch(fail); };
  $('pc-go').onclick = LOADERS.pincodes;
  $('pc-csv').onclick = function (e) { e.preventDefault(); location.href = '/api/admin/pincodes?format=csv&' + pcQ(); };
})();
