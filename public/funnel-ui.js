/* Daily funnel + lead board, shared by the call-centre page, Aman's page and admin.
   Every number comes from /api/cc/funnel (lib/funnel.js), so all pages always match.
   FunnelUI.mount(el, { teams:[{v,l}], team, openList(status, range, team), excel }) */
(function () {
  var TZ = 'Asia/Kolkata';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function nice(iso) { return new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }); }
  function pc(v) { return (v === null || v === undefined ? 0 : v) + '%'; }

  var css = '' +
    '.fu{margin:14px 24px;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:16px;padding:16px 18px;color:var(--ds-text);font-family:inherit}' +
    '.fu *{box-sizing:border-box}.fu h3{font-size:0.75rem;text-transform:uppercase;letter-spacing:.8px;color:var(--ds-muted);margin:18px 0 10px;font-weight:700}' +
    '.fu-top{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.fu-top label{display:block;font-size:0.75rem;font-weight:700;color:var(--ds-faint);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}' +
    '.fu-top select,.fu-top input{background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:8px 10px;border-radius:9px;font-size:0.75rem;font-family:inherit}' +
    '.fu-title{font-size:1rem;font-weight:800;margin-right:auto}.fu-title small{display:block;font-size:0.75rem;font-weight:500;color:var(--ds-muted);margin-top:2px}' +
    '.fu-btn{background:var(--ds-surface-2);color:var(--ds-text);border:1px solid var(--ds-border);border-radius:9px;padding:8px 14px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit}.fu-btn.go{background:var(--ds-brand);border-color:var(--ds-brand);color:#fff}.fu-btn.dl{background:var(--ds-brand);border-color:var(--ds-brand);color:#04130d}' +
    '.fu-note{font-size:0.75rem;color:var(--ds-muted);margin-top:10px;line-height:1.5}.fu-warn{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);color:var(--ds-warn-ink);border-radius:10px;padding:9px 12px;margin-top:10px;font-size:0.75rem}' +
    '.fu-grid{display:grid;grid-template-columns:minmax(300px,1.2fr) minmax(300px,1fr);gap:22px}@media(max-width:1000px){.fu-grid{grid-template-columns:1fr}.fu{margin:10px 12px}}' +
    '.fu-row{display:grid;grid-template-columns:1fr 64px 62px;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(30,45,74,.55);font-size:0.875rem}' +
    '.fu-row.sub{padding-left:22px;font-size:0.75rem;color:var(--ds-muted)}.fu-row.sub .fu-l:before{content:"↳ ";color:var(--ds-faint)}' +
    '.fu-l{display:flex;flex-direction:column;gap:5px}.fu-l small{color:var(--ds-muted);font-size:0.75rem}.fu-n{text-align:right;font-weight:800}.fu-p{text-align:right;color:var(--ds-muted);font-weight:700}' +
    '.fu-bar{height:5px;border-radius:3px;background:var(--ds-border);overflow:hidden}.fu-bar i{display:block;height:100%;border-radius:3px}' +
    '.c-all i{background:var(--ds-faint)}.c-att i{background:var(--ds-info)}.c-con i{background:var(--ds-brand)}.c-ok i{background:var(--ds-brand)}.c-bad i{background:var(--ds-danger)}.c-warn i{background:var(--ds-warn-ink)}' +
    '.fu-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px}' +
    '.fu-tile{background:var(--ds-surface-2);border:1px solid var(--ds-border);border-radius:12px;padding:11px 12px;text-align:left;color:var(--ds-text);font-family:inherit;cursor:pointer}.fu-tile:hover{border-color:var(--ds-brand)}.fu-tile[disabled]{cursor:default}.fu-tile[disabled]:hover{border-color:var(--ds-border)}' +
    '.fu-tile b{display:block;font-size:1.25rem;font-weight:800}.fu-tile span{font-size:0.75rem;text-transform:uppercase;letter-spacing:.5px;color:var(--ds-muted);font-weight:700}.fu-tile em{display:block;font-style:normal;font-size:0.75rem;color:var(--ds-muted);margin-top:3px}' +
    '.fu-tile.hot{border-color:var(--ds-warn-ink);background:rgba(245,158,11,.08)}.fu-tile.hot b{color:var(--ds-warn-ink)}.fu-tile.big{grid-column:1/-1;border-color:var(--ds-brand);background:rgba(99,102,241,.1)}.fu-tile.big b{color:var(--ds-brand)}' +
    '.fu-tile.ok b{color:var(--ds-brand)}.fu-tile.bad b{color:var(--ds-danger)}' +
    '.fu-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.fu-chip{background:var(--ds-surface);border:1px solid var(--ds-border);color:var(--ds-muted);border-radius:999px;padding:3px 9px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit}.fu-chip:hover{border-color:var(--ds-brand)}' +
    '.fu-tat{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px}.fu-tat div{background:var(--ds-surface-2);border:1px solid var(--ds-border);border-radius:12px;padding:10px 12px}.fu-tat b{display:block;font-size:1rem}.fu-tat span{font-size:0.75rem;text-transform:uppercase;color:var(--ds-muted);font-weight:700;letter-spacing:.5px}' +
    '.fu-tw{overflow:auto;border:1px solid var(--ds-border);border-radius:12px}.fu table{width:100%;border-collapse:collapse;font-size:0.75rem}.fu th{background:var(--ds-surface-2);color:var(--ds-faint);text-transform:uppercase;font-size:0.75rem;letter-spacing:.6px;padding:9px 10px;text-align:right;white-space:nowrap}' +
    '.fu th:first-child,.fu td:first-child{text-align:left}.fu td{padding:8px 10px;text-align:right;border-top:1px solid rgba(30,45,74,.6);white-space:nowrap}.fu td small{color:var(--ds-muted)}.fu tr.tot td{font-weight:800;background:var(--ds-surface-2)}' +
    '.fu-load{padding:26px;text-align:center;color:var(--ds-muted)}.fu-sep{font-size:0.75rem;text-transform:uppercase;letter-spacing:.7px;color:var(--ds-faint);font-weight:700;margin:14px 0 2px}' +
    // slim strip + pop-up
    '.fs{margin:8px 24px;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:12px;padding:8px 12px;color:var(--ds-text);font-family:inherit}.fs *{box-sizing:border-box}' +
    '.fs-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.fs select{background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:6px 8px;border-radius:8px;font-size:0.75rem;font-family:inherit}' +
    '.fs-chips{display:flex;gap:6px;flex-wrap:wrap;flex:1}.fs-chip{display:inline-flex;gap:7px;align-items:baseline;background:var(--ds-surface-2);border:1px solid var(--ds-border);color:var(--ds-muted);border-radius:999px;padding:6px 13px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}' +
    '.fs-chip b{font-size:1rem;color:var(--ds-text)}.fs-chip:hover{border-color:var(--ds-brand)}.fs-chip.big{border-color:var(--ds-brand);background:rgba(99,102,241,.16)}.fs-chip.big b{color:var(--ds-brand)}.fs-chip.hot{border-color:var(--ds-warn-ink)}.fs-chip.hot b{color:var(--ds-warn-ink)}.fs-chip.ok b{color:var(--ds-brand)}.fs-chip.bad b{color:var(--ds-danger)}' +
    '.fs-full{background:var(--ds-surface-2);border:1px solid var(--ds-border);color:var(--ds-text);border-radius:9px;padding:7px 13px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit}.fs-full:hover{border-color:var(--ds-brand)}' +
    '.fs-ov{position:fixed;inset:0;background:rgba(5,10,24,.85);z-index:450;display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:20px 12px}.fs-ov.on{display:flex}.fs-modal{width:min(1250px,100%);position:relative}.fs-modal .fu{margin:0}' +
    '.fs-x{position:absolute;top:10px;right:14px;z-index:2;background:var(--ds-surface-2);border:1px solid var(--ds-border);color:var(--ds-text);border-radius:50%;width:32px;height:32px;font-size:1rem;cursor:pointer}' +
    '@media(max-width:700px){.fs{margin:8px 12px}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function mount(el, opt) {
    opt = opt || {};
    var teams = opt.teams || [];
    var S = { product: '', period: opt.period || 'last3', team: opt.team || (teams[0] && teams[0].v) || 'all', from: '', to: '', data: null };
    el.classList.add('fu');
    el.innerHTML =
      '<div class="fu-top"><div class="fu-title">' + esc(opt.title || 'Daily report') + '<small id="fuSub"></small></div>' +
      (teams.length > 1 ? '<div><label>Team</label><select data-f="team">' + teams.map(function (t) { return '<option value="' + t.v + '"' + (t.v === S.team ? ' selected' : '') + '>' + esc(t.l) + '</option>'; }).join('') + '</select></div>' : '') +
      '<div><label>Product</label><select data-f="product"><option value="">All products</option></select></div>' +
      '<div><label>Orders placed</label><select data-f="period">' +
        '<option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option>' +
        '<option value="last10">Last 10 days</option><option value="last30">Last 30 days</option><option value="custom">Custom dates…</option></select></div>' +
      '<span data-r="custom" style="display:none"><div style="display:flex;gap:6px;align-items:flex-end"><div><label>From</label><input type="date" data-f="from"></div><div><label>To</label><input type="date" data-f="to"></div></div></span>' +
      '<button class="fu-btn go" data-a="go">Apply</button>' +
      (opt.excel ? '<button class="fu-btn dl" data-a="xl">Download Excel</button>' : '') + '</div>' +
      '<div id="fuBody"><div class="fu-load">Loading…</div></div>';
    el.querySelector('[data-f="period"]').value = S.period;

    function range() {
      var t = today();
      switch (S.period) {
        case 'today': return { from: t, to: t };
        case 'yesterday': var y = addDays(t, -1); return { from: y, to: y };
        case 'last3': return { from: addDays(t, -2), to: t };
        case 'last7': return { from: addDays(t, -6), to: t };
        case 'last10': return { from: addDays(t, -9), to: t };
        case 'last30': return { from: addDays(t, -29), to: t };
        default: return { from: el.querySelector('[data-f="from"]').value || t, to: el.querySelector('[data-f="to"]').value || t };
      }
    }
    function q() { var r = range(); return 'from=' + r.from + '&to=' + r.to + '&team=' + encodeURIComponent(S.team) + '&product=' + encodeURIComponent(S.product); }

    function row(label, n, p, cls, o) {
      o = o || {};
      return '<div class="fu-row' + (o.sub ? ' sub' : '') + '"><div class="fu-l"><span>' + label + '</span>' + (o.hint ? '<small>' + o.hint + '</small>' : '') +
        '<div class="fu-bar c-' + cls + '"><i style="width:' + Math.min(100, p || 0) + '%"></i></div></div><div class="fu-n">' + n + '</div><div class="fu-p">' + (p === null ? '' : pc(p)) + '</div></div>';
    }
    function tile(status, label, n, p, extra, cls) {
      var clickable = status && opt.openList;
      return '<button class="fu-tile ' + (cls || '') + '"' + (clickable ? ' data-open="' + status + '"' : ' disabled') + '><span>' + label + '</span><b>' + n + '</b><em>' + pc(p) + ' of orders' + (extra ? ' · ' + extra : '') + '</em></button>';
    }

    function render(d) {
      var f = d.funnel, p = d.pipeline, r = { from: d.from, to: d.to };
      el.querySelector('#fuSub').textContent = nice(d.from) + (d.from === d.to ? '' : ' – ' + nice(d.to)) + ' · COD orders placed in this period';
      var warn = '', since = d.calling_since || {};
      var names = { CC: 'the call centre', InHouse: 'Aman' };
      var teamsToCheck = d.team === 'CC' ? ['CC'] : d.team === 'InHouse' ? ['InHouse'] : ['CC', 'InHouse'];
      teamsToCheck.forEach(function (t) {
        if (!since[t]) warn += '<div class="fu-warn">No calls have been recorded yet for ' + names[t] + ', so every order shows as not attempted.</div>';
        else if (d.from < since[t]) warn += '<div class="fu-warn">Calls by ' + names[t] + ' are recorded from <b>' + nice(since[t]) + '</b>. Orders placed before that date show as not attempted because their calls were not logged.</div>';
      });
      var prepaidBox = d.prepaid ? '<div class="fu-tile" style="cursor:default;margin-top:12px"><span>Prepaid orders - kept separate</span><b>' + d.prepaid.orders + '</b><em>₹' + Math.round(d.prepaid.amount).toLocaleString('en-IN') + ' · paid online, never called' + (d.prepaid.converted ? ' · includes ' + d.prepaid.converted + ' converted from COD' : '') + ', so not in the COD funnel</em></div>' : '';
      var inFunnel = prepaidBox + '<div class="fu-note">Also left out of this report: <b>' + d.excluded.test_orders + '</b> test orders and <b>' + d.excluded.other_products + '</b> COD orders that are under ₹' + d.excluded.min_price + ' or not one of our teas.' +
        '</div>';

      var funnel =
        row('Total orders', f.total_orders, f.total_orders ? 100 : 0, 'all') +
        row('Attempted <small>(tried on any channel: call, IVR or WhatsApp)</small>', f.attempted, f.attempted_pct, 'att') +
        row('Total attempts <small>(calls, IVR calls and WhatsApp messages)</small>', f.total_attempts, null, 'att', { sub: true }) +
        row('Connected <small>(the customer answered, any channel)</small>', f.connected, f.connected_pct, 'con') +
        row('Confirmed <small>(all ways)</small>', f.confirmed, f.confirmed_pct, 'ok') +
        row('Cancelled <small>(the customer refused)</small>', f.cancelled, f.cancelled_pct, 'bad') +
        row('Not connected <small>(tried, nobody answered)</small>', f.not_connected, f.not_connected_pct, 'warn') +
        row('Second attempt done', f.nc_2nd, f.nc_2nd_pct, 'warn', { sub: true, hint: f.nc_2nd_of_nc_pct + '% of the not-connected' }) +
        row('Second attempt not done yet', f.nc_2nd_pending, f.not_connected ? Math.round(f.nc_2nd_pending * 1000 / f.not_connected) / 10 : 0, 'warn', { sub: true, hint: 'still to try again' }) +
        row('Third attempt done', f.nc_3rd, f.nc_3rd_pct, 'warn', { sub: true, hint: f.nc_3rd_of_nc_pct + '% of the not-connected' }) +
        row('Third attempt not done yet', f.nc_3rd_pending, f.not_connected ? Math.round(f.nc_3rd_pending * 1000 / f.not_connected) / 10 : 0, 'warn', { sub: true, hint: 'tried 2 times, needs a 3rd' }) +
        row('Not attempted yet', f.not_attempted, f.not_attempted_pct, 'all') +
        row('Still pending <small>(no final decision)</small>', f.pending, f.pending_pct, 'all') +
        '<div class="fu-sep">Of the confirmed and cancelled above, decided without a phone call</div>' +
        row('Confirmed on WhatsApp / IVR / sheet', f.confirmed_without_call, f.confirmed_without_call_pct, 'all', { sub: true }) +
        row('Cancelled on WhatsApp / IVR / sheet / other', f.cancelled_without_call, f.cancelled_without_call_pct, 'all', { sub: true });

      var nc = p.not_connected;
      var board =
        '<div class="fu-tiles">' +
        '<button class="fu-tile big"' + (opt.openList ? ' data-open="to_call_now"' : ' disabled') + '><span>To call right now</span><b>' + p.to_call_now + '</b><em>' + pc(p.pct.to_call_now) + ' of orders · fresh + not connected + callbacks due</em></button>' +
        tile('fresh', 'Fresh leads', p.fresh, p.pct.fresh, 'never called') +
        '<div class="fu-tile" style="cursor:default"><span>Not connected</span><b>' + nc + '</b><em>' + pc(p.pct.not_connected) + ' of orders</em>' +
          '<div class="fu-chips">' + [['nc_1', '1 attempt', p.nc_1], ['nc_2', '2 attempts', p.nc_2], ['nc_3_plus', '3+ attempts', p.nc_3_plus]].map(function (c) {
            return '<button class="fu-chip"' + (opt.openList ? ' data-open="' + c[0] + '"' : ' disabled') + '>' + c[1] + ': ' + c[2] + '</button>'; }).join('') + '</div></div>' +
        tile('callback_due', 'Callbacks due now', p.callback_due, p.pct.callback_due, 'agent promised to call', p.callback_due ? 'hot' : '') +
        tile('callback_later', 'Callbacks later', p.callback_later, p.pct.callback_later, 'scheduled') +
        tile('in_progress', 'Spoke, not decided', p.in_progress, p.pct.in_progress, 'open after a connected call') +
        tile('confirmed', 'Confirmed (all ways)', p.confirmed, p.pct.confirmed, '', 'ok') +
        tile('cancelled', 'Cancelled (all ways)', p.cancelled, p.pct.cancelled, 'see the list', 'bad') +
        tile('wrong_number', 'Wrong number', p.wrong_number, p.pct.wrong_number) +
        tile('unreachable', 'Unreachable (7 days)', p.unreachable, p.pct.unreachable) +
        tile('dnc', 'Do not call', p.dnc, p.pct.dnc) +
        tile('short_open', 'Short address to fix', p.short_open, p.pct.short_open,
          p.short_open_confirmed ? '<b style="color:var(--ds-warn-ink)">' + p.short_open_confirmed + ' already confirmed — fix before shipping</b>' : 'not shipped yet', p.short_open ? 'hot' : '') +
        '</div>' +
        (p.short_open ? '<div class="fu-chips"><button class="fu-chip"' + (opt.openList ? ' data-open="short_open_confirmed"' : ' disabled') + '>Short address, confirmed: ' + p.short_open_confirmed + '</button>' +
          '<button class="fu-chip"' + (opt.openList ? ' data-open="short_open_pending"' : ' disabled') + '>Short address, still pending: ' + p.short_open_pending + '</button></div>' : '') +
        (p.duplicates_open ? '<div class="fu-note">Duplicate orders waiting for review: <b>' + p.duplicates_open + '</b></div>' : '');

      var sku = d.by_sku && d.by_sku.rows.length ? ('<div class="fu-tw"><table><thead><tr><th>Product</th><th>Orders</th><th>Units (qty)</th><th>Qty 1</th><th>Qty 2</th><th>Qty 3+</th><th>Attempted</th><th>Connected</th><th>Confirmed</th><th>Cancelled</th><th>Not connected</th></tr></thead><tbody>' +
        d.by_sku.rows.map(function (x) {
          return '<tr><td>' + (opt.openList ? '<a href="#" data-sku="' + esc(x.key) + '" style="color:var(--ds-brand);text-decoration:none;font-weight:700">' + esc(x.name) + '</a>' : esc(x.name)) + '</td><td>' + x.orders + '</td><td><b>' + x.units + '</b></td><td>' + x.qty1 + '</td><td>' + x.qty2 + '</td><td>' + x.qty3_plus + '</td><td>' + x.attempted + ' <small>(' + pc(x.attempted_pct) + ')</small></td><td>' + x.connected + ' <small>(' + pc(x.connected_pct) + ')</small></td><td>' + x.confirmed + ' <small>(' + pc(x.confirmed_pct) + ')</small></td><td>' + x.cancelled + ' <small>(' + pc(x.cancelled_pct) + ')</small></td><td>' + x.not_connected + ' <small>(' + pc(x.not_connected_pct) + ')</small></td></tr>';
        }).join('') + '<tr class="tot"><td>Total units</td><td></td><td>' + d.by_sku.total_units + '</td><td colspan="8"></td></tr></tbody></table></div>') : '<div class="fu-load">No orders in this period</div>';

      var tat = '<div class="fu-tat">' +
        '<div><b>' + f.tat_fmt.order_to_1st + '</b><span>Order → 1st connect</span></div>' +
        '<div><b>' + f.tat_fmt.first_to_2nd + '</b><span>1st → 2nd connect</span></div>' +
        '<div><b>' + f.tat_fmt.second_to_3rd + '</b><span>2nd → 3rd connect</span></div>' +
        '<div><b>' + f.tat_fmt.order_to_decision + '</b><span>Order → confirmed / cancelled</span></div></div>';

      function cell(n, p2) { return n + ' <small>(' + pc(p2) + ')</small>'; }
      var days = '<div class="fu-tw"><table><thead><tr><th>Order date</th><th>Orders</th><th>Attempted</th><th>Total attempts</th><th>Connected</th><th>Confirmed</th><th>Cancelled</th><th>Not connected</th><th>2nd done</th><th>2nd not done</th><th>3rd done</th><th>3rd not done</th></tr></thead><tbody>' +
        d.days.map(function (x) {
          return '<tr><td>' + esc(nice(x.day)) + '</td><td>' + x.total_orders + '</td><td>' + cell(x.attempted, x.attempted_pct) + '</td><td>' + x.total_attempts + '</td><td>' + cell(x.connected, x.connected_pct) + '</td><td>' + cell(x.confirmed, x.confirmed_pct) +
            '</td><td>' + cell(x.cancelled, x.cancelled_pct) + '</td><td>' + cell(x.not_connected, x.not_connected_pct) + '</td><td>' + cell(x.nc_2nd, x.nc_2nd_pct) + '</td><td>' + x.nc_2nd_pending + '</td><td>' + cell(x.nc_3rd, x.nc_3rd_pct) + '</td><td>' + x.nc_3rd_pending + '</td></tr>';
        }).join('') +
        '<tr class="tot"><td>Total</td><td>' + f.total_orders + '</td><td>' + cell(f.attempted, f.attempted_pct) + '</td><td>' + f.total_attempts + '</td><td>' + cell(f.connected, f.connected_pct) + '</td><td>' + cell(f.confirmed, f.confirmed_pct) +
          '</td><td>' + cell(f.cancelled, f.cancelled_pct) + '</td><td>' + cell(f.not_connected, f.not_connected_pct) + '</td><td>' + cell(f.nc_2nd, f.nc_2nd_pct) + '</td><td>' + f.nc_2nd_pending + '</td><td>' + cell(f.nc_3rd, f.nc_3rd_pct) + '</td><td>' + f.nc_3rd_pending + '</td></tr></tbody></table></div>';

      el.querySelector('#fuBody').innerHTML = warn +
        '<div class="fu-grid"><div><h3>Funnel — all % are of total orders</h3>' + funnel + inFunnel + '</div>' +
        '<div><h3>Where my leads are right now' + (opt.openList ? ' (click a box to see the list)' : '') + '</h3>' + board + '</div></div>' +
        '<h3>By product (SKU) - orders and quantity' + (opt.openList ? ' (click a product to see its orders)' : '') + '</h3>' + sku + '<h3>Turnaround time</h3>' + tat + '<h3>Day by day</h3>' + (d.days.length ? days : '<div class="fu-load">No orders in this period</div>');
      S.range = r;
    }

    function load() {
      el.querySelector('#fuBody').innerHTML = '<div class="fu-load">Loading…</div>';
      return fetch('/api/cc/funnel?' + q()).then(function (res) {
        if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || ('Error ' + res.status)); return j; });
      }).then(function (d) {
        var ps = el.querySelector('[data-f="product"]');
        if (ps && ps.options.length <= 1) { (d.products || []).forEach(function (p) { var o = document.createElement('option'); o.value = p.key; o.textContent = p.name; ps.appendChild(o); }); ps.value = S.product; }
        S.data = d; render(d); })
        .catch(function (e) { if (e.message !== 'login') el.querySelector('#fuBody').innerHTML = '<div class="fu-warn">Could not load the report: ' + esc(e.message) + '</div>'; });
    }

    el.addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f');
      if (f === 'period') { S.period = e.target.value; el.querySelector('[data-r="custom"]').style.display = S.period === 'custom' ? '' : 'none'; if (S.period !== 'custom') load(); }
      if (f === 'team') { S.team = e.target.value; load(); }
      if (f === 'product') { S.product = e.target.value; load(); }
    });
    el.addEventListener('click', function (e) {
      var sk = e.target.closest('[data-sku]');
      if (sk) { e.preventDefault(); if (opt.openList) opt.openList('', S.range || range(), S.team, sk.getAttribute('data-sku')); return; }
      var b = e.target.closest('[data-a],[data-open]'); if (!b) return;
      if (b.getAttribute('data-a') === 'go') load();
      if (b.getAttribute('data-a') === 'xl') { var a = document.createElement('a'); a.href = opt.excel + '?' + q(); document.body.appendChild(a); a.click(); a.remove(); }
      if (b.getAttribute('data-open') && opt.openList) opt.openList(b.getAttribute('data-open'), S.range || range(), S.team, S.product);
    });

    load();
    return { refresh: load };
  }

  // One slim row of clickable counts (the working view) + the full report in a pop-up.
  function strip(el, opt) {
    opt = opt || {};
    var teams = opt.teams || [];
    var S = { team: opt.team || (teams[0] && teams[0].v) || 'all', period: opt.period || 'all', range: null, full: null };
    el.classList.add('fs');
    el.innerHTML = '<div class="fs-row">' +
      (teams.length > 1 ? '<select data-s="team" title="Which team">' + teams.map(function (t) { return '<option value="' + t.v + '"' + (t.v === S.team ? ' selected' : '') + '>' + esc(t.l) + '</option>'; }).join('') + '</select>' : '') +
      (opt.workPage ? '' : '<select data-s="period" title="Which orders"><option value="all">All open leads</option><option value="today">Orders placed today</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option></select>') +
      '<div class="fs-chips" data-s="chips"><span style="color:var(--ds-muted);font-size:0.75rem">Loading…</span></div>' +
      (opt.scoreView ? '<button class="fs-full" data-s="score" title="How the team is doing" style="border-color:var(--ds-brand);color:var(--ds-brand)">My score</button>' : '') +
      (opt.channelsView && !opt.workPage ? '<button class="fs-full" data-s="calls" title="Calls, confirmed and cancelled">Calls report</button>' : '') +
      (opt.workPage ? '' : '<button class="fs-full" data-s="full">Full report</button>') + '</div>';
    if (el.querySelector('[data-s="period"]')) el.querySelector('[data-s="period"]').value = S.period;

    var overlay = document.createElement('div');
    overlay.className = 'fs-ov';
    overlay.innerHTML = '<div class="fs-modal"><button class="fs-x" title="Close">×</button><div data-s="body"></div></div>';
    document.body.appendChild(overlay);
    function closeFull() { overlay.classList.remove('on'); }
    overlay.querySelector('.fs-x').onclick = closeFull;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeFull(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.querySelectorAll('.fs-ov.on').forEach(function (o) { o.classList.remove('on'); }); });

    var calls = null, callsOverlay = null;
    if (opt.channelsView && !opt.workPage) {
      callsOverlay = document.createElement('div'); callsOverlay.className = 'fs-ov';
      callsOverlay.innerHTML = '<div class="fs-modal"><button class="fs-x" title="Close">×</button><div data-s="cbody"></div></div>';
      document.body.appendChild(callsOverlay);
      callsOverlay.querySelector('.fs-x').onclick = function () { callsOverlay.classList.remove('on'); };
      callsOverlay.addEventListener('click', function (e) { if (e.target === callsOverlay) callsOverlay.classList.remove('on'); });
    }
    var scoreOv = null, scoreInst = null;
    if (opt.scoreView) {
      scoreOv = document.createElement('div'); scoreOv.className = 'fs-ov';
      scoreOv.innerHTML = '<div class="fs-modal" style="background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:16px"><button class="fs-x" title="Close">×</button><div data-s="sbody"></div></div>';
      document.body.appendChild(scoreOv);
      scoreOv.querySelector('.fs-x').onclick = function () { scoreOv.classList.remove('on'); };
      scoreOv.addEventListener('click', function (e) { if (e.target === scoreOv) scoreOv.classList.remove('on'); });
    }
    function openScore() {
      if (!scoreOv || !window.ScoreboardUI) return;
      scoreOv.classList.add('on');
      if (!scoreInst) scoreInst = ScoreboardUI.mount(scoreOv.querySelector('[data-s="sbody"]'), { view: opt.scoreView, title: opt.scoreTitle || 'My score' }); else scoreInst.refresh();
    }
    function openCalls() {
      if (!callsOverlay || !window.ChannelUI) return;
      callsOverlay.classList.add('on');
      if (!calls) calls = ChannelUI.mount(callsOverlay.querySelector('[data-s="cbody"]'), { view: opt.channelsView, title: opt.channelsTitle || 'Calls report' }); else calls.refresh();
    }

    function range() {
      var t = today();
      if (S.period === 'today') return { from: t, to: t };
      if (S.period === 'last3') return { from: addDays(t, -2), to: t };
      if (S.period === 'last7') return { from: addDays(t, -6), to: t };
      return { from: addDays(t, -364), to: t };
    }
    function chip(status, label, n, cls, tip) {
      return '<button class="fs-chip ' + (cls || '') + '" data-status="' + status + '" title="' + esc(tip || 'Show these orders') + '">' + label + ' <b>' + n + '</b></button>';
    }
    function load() {
      var r = range(); S.range = r;
      return fetch('/api/cc/funnel?from=' + r.from + '&to=' + r.to + '&team=' + encodeURIComponent(S.team)).then(function (res) {
        if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || ('Error ' + res.status)); return j; });
      }).then(function (d) {
        var p = d.pipeline, cb = p.callback_due + p.callback_later;
        // Work pages: the numbers of leads to call live in the queue chips under the tabs (one definition). Only the address list stays here.
        if (opt.workPage) { el.querySelector('[data-s="chips"]').innerHTML = chip('short_open', 'Short address to fix', p.short_open, p.short_open ? 'hot' : '', 'Address still to fix, not shipped yet (' + p.short_open_confirmed + ' already confirmed)'); return; }
        el.querySelector('[data-s="chips"]').innerHTML =
          chip('to_call_now', 'To call now', p.to_call_now, 'big', 'Fresh + not connected + callbacks due') +
          chip('fresh', 'Fresh', p.fresh, '', 'Never called') +
          chip('not_connected', 'Not connected', p.not_connected, p.not_connected ? 'hot' : '', 'Called, never picked up (' + p.nc_1 + ' with 1 attempt, ' + p.nc_2 + ' with 2, ' + p.nc_3_plus + ' with 3+)') +
          chip('callback', 'Callbacks', cb, p.callback_due ? 'hot' : '', p.callback_due + ' due now, ' + p.callback_later + ' later') +
          chip('confirmed', 'Confirmed', p.confirmed, 'ok') +
          chip('cancelled', 'Cancelled', p.cancelled, 'bad') +
          chip('short_open', 'Short address', p.short_open, p.short_open ? 'hot' : '', 'Address still to fix, not shipped yet (' + p.short_open_confirmed + ' already confirmed)');
      }).catch(function (e) { if (e.message !== 'login') el.querySelector('[data-s="chips"]').innerHTML = '<span style="color:var(--ds-warn-ink);font-size:0.75rem">Could not load: ' + esc(e.message) + '</span>'; });
    }
    function openFull() {
      overlay.classList.add('on');
      if (!S.full) {
        S.full = mount(overlay.querySelector('[data-s="body"]'), {
          title: opt.title || 'Daily report', team: S.team, teams: teams, period: 'last3', excel: opt.excel,
          openList: opt.openList ? function (status, range2, team, product) { closeFull(); opt.openList(status, range2, team, product); } : null
        });
      } else S.full.refresh();
    }
    el.addEventListener('change', function (e) {
      var s = e.target.getAttribute('data-s');
      if (s === 'team') { S.team = e.target.value; S.full = null; overlay.querySelector('[data-s="body"]').innerHTML = ''; load(); }
      if (s === 'period') { S.period = e.target.value; load(); }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-status],[data-s="full"],[data-s="calls"],[data-s="score"]'); if (!b) return;
      if (b.getAttribute('data-s') === 'score') return openScore();
      if (b.getAttribute('data-s') === 'calls') return openCalls();
      if (b.getAttribute('data-s') === 'full') { if (opt.reportTab && document.querySelector(opt.reportTab)) { document.querySelector(opt.reportTab).click(); return; } return openFull(); }
      if (opt.openList) opt.openList(b.getAttribute('data-status'), S.range || range(), S.team, '', b.textContent.replace(/\s*\d+$/, '').trim());
    });
    load();
    return { refresh: function () { load(); if (S.full && overlay.classList.contains('on')) S.full.refresh(); } };
  }

  window.FunnelUI = { mount: mount, strip: strip };
})();
