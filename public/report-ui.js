/* The one report. Data: /api/cc/report. Three blocks that are never mixed:
   A. orders placed in the dates (by order date)   B. calls made in the dates (by call date)   C. open right now
   ReportUI.mount(el, { title, team: 'all'|'cc'|'inhouse', teams: [{v,l}], excel: '/api/cc/funnel/download', openList: fn }) */
(function () {
  var TZ = 'Asia/Kolkata';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function pct(a, b) { return b ? (Math.round(a * 1000 / b) / 10) + '%' : '-'; }
  function nice(iso) { return new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }); }

  var css = '.rp{color:var(--ds-text);font-family:inherit;padding:14px 16px}.rp *{box-sizing:border-box}' +
    '.rp-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px}.rp-title{font-size:1rem;font-weight:800;margin-right:auto}' +
    '.rp select,.rp input[type=date]{background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:8px 10px;border-radius:9px;font-size:0.75rem;font-family:inherit}' +
    '.rp-btn{background:var(--ds-brand);color:#04170f;border:0;border-radius:9px;padding:9px 14px;font-weight:800;font-size:0.75rem;cursor:pointer;font-family:inherit}' +
    '.rp-sub{font-size:0.75rem;color:var(--ds-muted);margin-bottom:4px}' +
    '.rp h3{font-size:0.75rem;text-transform:uppercase;letter-spacing:.8px;color:var(--ds-muted);margin:22px 0 4px;font-weight:800}.rp h3 b{color:var(--ds-text)}' +
    '.rp-what{font-size:0.75rem;color:var(--ds-muted);margin-bottom:9px;line-height:1.5}' +
    '.rp-card{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:13px;overflow:hidden}' +
    '.rp-row{display:grid;grid-template-columns:1fr 90px 76px;gap:10px;padding:10px 14px;border-top:1px solid rgba(30,45,74,.6);font-size:0.875rem;align-items:center}.rp-row:first-child{border-top:0}' +
    '.rp-row .l small{display:block;color:var(--ds-muted);font-size:0.75rem;margin-top:1px}.rp-row .n{text-align:right;font-weight:800;font-size:1rem}.rp-row .p{text-align:right;color:var(--ds-muted);font-size:0.75rem}' +
    '.rp-row.sub{padding-left:30px;background:rgba(19,28,51,.55)}.rp-row.sub .n{font-size:0.875rem;font-weight:700}.rp-row.hd{font-size:0.75rem;text-transform:uppercase;letter-spacing:.6px;color:var(--ds-faint);background:var(--ds-surface-2);padding:7px 14px}' +
    '.rp-row.ok .n{color:var(--ds-brand)}.rp-row.bad .n{color:var(--ds-danger)}.rp-row.warn .n{color:var(--ds-warn-ink)}' +
    '.rp-recon{margin-top:9px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.4);color:#bcd3ff;border-radius:10px;padding:10px 12px;font-size:0.875rem;line-height:1.5}' +
    '.rp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}.rp-tile{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:13px;padding:12px 13px;text-align:left;color:inherit;font-family:inherit}' +
    '.rp-tile .l{font-size:0.75rem;text-transform:uppercase;letter-spacing:.5px;color:var(--ds-muted);font-weight:700}.rp-tile .v{font-size:1.75rem;font-weight:800;margin:3px 0 2px;line-height:1.1}.rp-tile .c{font-size:0.75rem;color:var(--ds-muted)}' +
    '.rp-tile.ok .v{color:var(--ds-brand)}.rp-tile.bad .v{color:var(--ds-danger)}.rp-tile.warn .v{color:var(--ds-warn-ink)}button.rp-tile{cursor:pointer}button.rp-tile:hover{border-color:#3b6cb8}' +
    '.rp-tw{overflow-x:auto;border:1px solid var(--ds-border);border-radius:12px}.rp table{width:100%;border-collapse:collapse;font-size:0.75rem;min-width:720px}.rp th{background:var(--ds-surface-2);color:var(--ds-faint);text-transform:uppercase;font-size:0.75rem;letter-spacing:.5px;padding:8px 9px;text-align:right;white-space:nowrap}' +
    '.rp th:first-child,.rp td:first-child{text-align:left}.rp td{padding:8px 9px;text-align:right;border-top:1px solid rgba(30,45,74,.6);white-space:nowrap}.rp tr.tot td{font-weight:800;background:var(--ds-surface-2)}' +
    '.rp-def{font-size:0.75rem;color:var(--ds-muted);line-height:1.6;margin:0;padding-left:18px}.rp-err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:var(--ds-danger);border-radius:10px;padding:10px 12px;font-size:0.875rem}.rp-load{padding:30px;text-align:center;color:var(--ds-muted)}' +
    '@media(max-width:560px){.rp{padding:12px 10px}.rp-row{grid-template-columns:1fr 70px 62px;padding:9px 10px}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function mount(el, opt) {
    opt = opt || {};
    var S = { period: 'today', team: opt.team || 'all', from: today(), to: today() };
    var teams = opt.teams || [{ v: 'all', l: 'All teams' }, { v: 'cc', l: 'Call centre' }, { v: 'inhouse', l: 'Aman' }];
    el.classList.add('rp');
    el.innerHTML = '<div class="rp-top"><div class="rp-title">' + esc(opt.title || 'Daily report') + '</div>' +
      (teams.length > 1 ? '<select data-s="team">' + teams.map(function (t) { return '<option value="' + t.v + '">' + esc(t.l) + '</option>'; }).join('') + '</select>' : '') +
      '<select data-s="period"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option><option value="last30">Last 30 days</option><option value="month">This month</option><option value="custom">Custom dates</option></select>' +
      '<span data-s="custom" style="display:none"><input type="date" data-s="from"> to <input type="date" data-s="to"> <button class="rp-btn" data-s="apply">Apply</button></span>' +
      (opt.excel ? '<button class="rp-btn" data-s="xls">Download Excel</button>' : '') + '</div><div class="rp-sub" id="rpSub"></div><div id="rpBody"><div class="rp-load">Loading…</div></div>';
    el.querySelector('[data-s="team"]') && (el.querySelector('[data-s="team"]').value = S.team);

    function range() {
      var t = today();
      switch (S.period) {
        case 'yesterday': var y = addDays(t, -1); return { from: y, to: y };
        case 'last3': return { from: addDays(t, -2), to: t };
        case 'last7': return { from: addDays(t, -6), to: t };
        case 'last30': return { from: addDays(t, -29), to: t };
        case 'month': return { from: t.slice(0, 8) + '01', to: t };
        case 'custom': return { from: S.from, to: S.to };
        default: return { from: t, to: t };
      }
    }
    function row(label, n, p, cls, o) { o = o || {}; return '<div class="rp-row ' + (o.sub ? 'sub ' : '') + (cls || '') + '"><div class="l">' + label + (o.hint ? '<small>' + o.hint + '</small>' : '') + '</div><div class="n">' + num(n) + '</div><div class="p">' + (p == null ? '' : p) + '</div></div>'; }
    function tile(label, v, caption, cls, status) {
      var inner = '<div class="l">' + label + '</div><div class="v">' + (typeof v === 'number' ? num(v) : v) + '</div><div class="c">' + caption + '</div>';
      return opt.openList && status ? '<button class="rp-tile ' + (cls || '') + '" data-open="' + status + '">' + inner + '</button>' : '<div class="rp-tile ' + (cls || '') + '">' + inner + '</div>';
    }
    function table(head, rowsHtml) { return '<div class="rp-tw"><table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'; }

    function p1(v) { return v == null ? '—' : v + '%'; }
    function dur(m) { return m == null ? '—' : m < 120 ? m + ' min' : (Math.round(m / 6) / 10) + ' h'; }
    function hrLabel(n) { return ('0' + n).slice(-2) + ':00 – ' + ('0' + ((n + 1) % 24)).slice(-2) + ':00'; }
    function trs(rows) { return rows.map(function (r) { return '<tr' + (r.tot ? ' class="tot"' : '') + '>' + r.c.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr>'; }).join(''); }
    function overviewHtml(an) {
      var o = an.overview, w = o.whatsapp, k = o.calling, v = o.ivr, T = o.orders, h = '';
      h += '<h3>Overview: all channels together</h3><div class="rp-what">Same four blocks as your sheet. Confirmed and cancelled count every channel. Connectivity = the customer was reached on WhatsApp, IVR or a call.</div>';
      h += '<div class="rp-grid">' + tile('COD orders', o.orders, 'in these dates', '') + tile('Confirmed', p1(o.confirmed_pct), num(o.confirmed) + ' orders · all channels', 'ok') + tile('Cancelled', p1(o.cancelled_pct), num(o.cancelled) + ' orders', o.cancelled ? 'bad' : '') +
        tile('Connectivity', p1(o.connectivity_pct), num(o.reached) + ' reached · WhatsApp, IVR or call', '') + tile('Still unconfirmed', o.unconfirmed, 'orders', o.unconfirmed ? 'warn' : '') + '</div>';
      h += '<div class="rp-grid" style="margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">' +
        '<div class="rp-card"><div class="rp-row hd"><div>WhatsApp</div><div></div><div></div></div>' + row('Confirmed on WhatsApp', w.confirmed, p1(w.confirmed_pct)) + row('Cancelled on WhatsApp', w.cancelled, '') +
          '<div class="rp-row"><div class="l" style="color:var(--ds-muted)">Reply rate and reply time need the sheet</div><div></div><div></div></div></div>' +
        '<div class="rp-card"><div class="rp-row hd"><div>Manual calling</div><div></div><div></div></div>' + row('Orders called', k.orders_called, pct(k.orders_called, T)) + row('Calls made', k.calls_made, '') +
          row('Connect rate', k.connected_calls, p1(k.connect_pct), '', { hint: 'calls picked up, of calls made' }) + row('Confirmed on call', k.confirmed, p1(k.confirm_pct_of_called), 'ok', { hint: '% of orders called' }) + row('Cancelled on call', k.cancelled, '') +
          '<div class="rp-row"><div class="l">Order to 1st call<small>median</small></div><div class="n">' + dur(k.median_to_first_call_min) + '</div><div class="p"></div></div>' +
          '<div class="rp-row"><div class="l">Order to 1st connected call<small>median</small></div><div class="n">' + dur(k.median_to_first_connected_min) + '</div><div class="p"></div></div></div>' +
        '<div class="rp-card"><div class="rp-row hd"><div>IVR</div><div></div><div></div></div>' + row('Confirmed on IVR', v.confirmed, '') + row('Cancelled on IVR', v.cancelled, '') +
          '<div class="rp-row"><div class="l" style="color:var(--ds-muted)">Calls placed and answered need the sheet</div><div></div><div></div></div></div></div>';
      return h;
    }
    function analysisHtml(an) {
      var h = '', hh = an.by_hour, tot = hh.reduce(function (s, x) { return { o: s.o + x.orders, c: s.c + x.calls, k: s.k + x.connected, f: s.f + x.call_confirmed, n: s.n + x.no_response }; }, { o: 0, c: 0, k: 0, f: 0, n: 0 });
      h += '<h3>1. By hour of day: when orders come in, and when calls work</h3>' + table(['Hour', 'COD orders', 'Avg / day', 'WA confirm %', 'Confirmed %', 'Cancelled %', 'Calls made', 'Connected', 'Connect %', 'Confirmed', 'Confirm % of calls', 'No response'],
        trs(hh.map(function (x) { return { c: [hrLabel(x.hour), num(x.orders), x.avg_orders_per_day, p1(x.wa_confirm_pct), p1(x.confirmed_pct), p1(x.cancelled_pct), num(x.calls), num(x.connected), p1(x.connect_pct), num(x.call_confirmed), p1(x.call_confirm_pct), num(x.no_response)] }; })
          .concat([{ tot: 1, c: ['Total', num(tot.o), '', '', '', '', num(tot.c), num(tot.k), p1(pct0(tot.k, tot.c)), num(tot.f), p1(pct0(tot.f, tot.c)), num(tot.n)] }]))) +
        '<div class="rp-what" style="margin-top:6px">Calls are counted in the hour they were made, on any order. Orders are counted in the hour they were placed.</div>';
      var g1 = an.timing.first_call, fast = g1[0], slow = g1[g1.length - 1];
      h += '<h3>2. Timing: does calling sooner help?</h3>' + (fast.orders && slow.orders && fast.confirm_pct != null && slow.confirm_pct != null ? '<div class="rp-recon">Orders first called within 30 minutes confirm on a call <b>' + fast.confirm_pct + '%</b> of the time. After 24 hours it is <b>' + slow.confirm_pct + '%</b>.</div>' : '') +
        '<div class="rp-grid" style="margin-top:8px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">' +
        '<div><div class="rp-what">Gap between order and 1st call</div>' + table(['Gap', 'Orders called', 'Confirmed on call', 'Confirm %'], trs(g1.map(function (x) { return { c: [x.label, num(x.orders), num(x.confirmed), p1(x.confirm_pct)] }; }))) + '</div>' +
        '<div><div class="rp-what">Gap between order and 1st connected call</div>' + table(['Gap', 'Orders', 'Confirmed on call', 'Confirm %'], trs(an.timing.first_connected.map(function (x) { return { c: [x.label, num(x.orders), num(x.confirmed), p1(x.confirm_pct)] }; }))) + '</div></div>' +
        '<div class="rp-what" style="margin-top:6px">WhatsApp reply speed needs the sheet (the CRM only receives the outcome).</div>';
      var out = an.outcomes, outTot = out.reduce(function (s, x) { return s + x.orders; }, 0);
      h += '<h3>3. Call attempts and where every order ended up</h3><div class="rp-grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">' +
        '<div><div class="rp-what">Calling by attempt</div>' + table(['Attempt', 'Calls made', 'Connected', 'Connect %', 'Confirmed on this call', 'Cumulative confirmed %'], trs(an.attempts.map(function (x) { return { c: ['Call ' + x.attempt, num(x.calls_made), num(x.connected), p1(x.connect_pct), num(x.confirmed_on_call), p1(x.cumulative_confirmed_pct)] }; }))) + '</div>' +
        '<div><div class="rp-what">Where every COD order ended up (adds up to the orders)</div>' + table(['Status', 'Orders', '% of orders'], trs(out.filter(function (x) { return x.orders; }).map(function (x) { return { c: [esc(x.label), num(x.orders), p1(x.pct)] }; }).concat([{ tot: 1, c: ['Total', num(outTot), '100%'] }]))) + '</div></div>';
      h += '<h3>4. Confirmation journey: when and through which step</h3><div class="rp-what">D0 = within 24 hours of the order, D1 = 24 to 48 hours, D2+ = after 48 hours.</div>' + table(['Window', 'WhatsApp', 'IVR', 'Call', 'Other', 'Total confirmed', '% of orders', 'Cumulative %', 'Cancelled'],
        trs(an.journey.filter(function (x) { return x.confirmed || x.cancelled || x.window !== 'unknown'; }).map(function (x) { return { c: [esc(x.label), num(x.wa), num(x.ivr), num(x.call), num(x.other), num(x.confirmed), p1(x.confirmed_pct), p1(x.cumulative_pct), num(x.cancelled)] }; }))) +
        '<div class="rp-what" style="margin-top:6px">"Day unknown" = confirmed but the decision time was not recorded. Reminder steps need the sheet.</div>';
      h += '<h3>5. Daily, by order date</h3>' + table(['Order date', 'COD orders', 'Confirmed D0', 'D1', 'D2+', 'Day unknown', 'Total confirmed', 'Confirmed %', 'D0 confirmed %', 'Cancelled', 'Still pending', 'Reached', 'Connectivity D0', 'Till D1', 'All'],
        trs(an.daily.map(function (x) { return { c: [esc(nice(x.day)), num(x.orders), num(x.confirmed_d0), num(x.confirmed_d1), num(x.confirmed_d2), num(x.confirmed_unknown), num(x.confirmed), p1(x.confirmed_pct), p1(x.confirmed_d0_pct), num(x.cancelled), num(x.pending), num(x.reached), p1(x.connectivity_d0_pct), p1(x.connectivity_till_d1_pct), p1(x.connectivity_all_pct)] }; })));
      var mx = Math.max(1, Math.max.apply(null, an.grid.map(function (r) { return Math.max.apply(null, r.hours); })));
      h += '<h3>6. Orders by date and hour (COD)</h3><div class="rp-tw"><table style="min-width:980px"><thead><tr><th>Date</th>' + an.grid[0].hours.map(function (_, i) { return '<th>' + ('0' + i).slice(-2) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        an.grid.map(function (r) { return '<tr><td>' + esc(nice(r.day)) + '</td>' + r.hours.map(function (v) { return '<td style="padding:6px 4px;text-align:center;' + (v ? 'background:rgba(59,130,246,' + (0.12 + 0.55 * v / mx).toFixed(2) + ')' : '') + '">' + (v || '') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
      return h;
    }
    function pct0(a, b) { return b ? Math.round(a * 1000 / b) / 10 : null; }
    // End to end: every order down to the confirmation. Count and percentage on every line, then the same day by day (order date).
    function e2eHtml(e) {
      if (!e || !e.table) return '';
      var h = '<h3>End to end: from every order to the confirmation</h3><div class="rp-what">Every line has a count and a percentage. Under each line it says what the percentage is of. Orders are those placed in these dates.</div><div class="rp-card">' +
        '<div class="rp-row hd"><div>Measure</div><div style="text-align:right">Count</div><div style="text-align:right">%</div></div>';
      e.table.forEach(function (x) {
        var hint = (x.base ? '% ' + x.base : '') + (x.hint ? (x.base ? ' · ' : '') + x.hint : '');
        h += row(esc(x.label), x.count, x.pct == null ? '' : x.pct + '%', x.tone, { hint: esc(hint) });
      });
      h += '</div>';
      var apct = function (x) { if (x.attempted_pct == null) return '—'; return '<span style="' + (x.attempted_pct < 100 && !x.is_today ? 'color:var(--ds-danger);font-weight:800' : '') + '">' + x.attempted_pct + '%</span>'; };
      var cells = function (x, label) {
        return { tot: label === 'Total', c: [label, num(x.total), num(x.prepaid), num(x.cod), num(x.needed_call), num(x.attempted), apct(x), num(x.calls), num(x.connected), p1(x.connected_pct), num(x.not_connected), num(x.rejected),
          num(x.confirmed_all), p1(x.confirmed_pct), num(x.pending), (x.is_today && x.not_attempted ? num(x.not_attempted) + ' (waiting)' : num(x.not_attempted))] };
      };
      h += '<div class="rp-what" style="margin-top:14px">Day by day, by order date. Attempted % is shown in red when a past day is below 100%: that is the day calls were missed. Today is still open, so its uncalled orders are only waiting.</div>' +
        table(['Order date', 'Total orders', 'Prepaid', 'COD', 'Needed a call', 'Attempted', 'Attempted %', 'Calls made', 'Connected', 'Connected %', 'Not connected', 'Rejected', 'Confirmed (all ways)', 'Confirmed %', 'Pending', 'Not attempted'],
          trs(e.days.map(function (x) { return cells(x, esc(nice(x.day))); }).concat([cells(e.totals, 'Total')])));
      h += '<div class="rp-what" style="margin-top:6px">Needed a call = COD orders that nobody closed without a call (WhatsApp, IVR, sheet or automatic). Connected = the customer spoke on a call; address-fix, callback and do-not-call calls count as connected. Not connected = called, nobody ever picked up. Rejected = cancelled by the customer on a call. Call pick-up (picked up / calls made) is a different number from orders connected, so it is shown only in the Calls line.</div>';
      return h;
    }
    // The end-to-end block on the right base (lib/codReport.js): COD orders are 100%, all four channels count, prepaid is one separate line that no percentage uses.
    function codHtml(e) {
      var h = '<h3>End to end: from every COD order to the confirmation</h3><div class="rp-what">Every percentage is a share of the <b>COD orders</b> placed in these dates. Prepaid orders ship directly and are not counted. Calls, IVR and WhatsApp all count. Goal: <b>' + e.goal + '% confirmed</b>.</div><div class="rp-card">' +
        '<div class="rp-row hd"><div>Measure</div><div style="text-align:right">Count</div><div style="text-align:right">%</div></div>';
      e.table.forEach(function (x) { var lead = x.base ? ((x.pct != null && x.pct !== 100 ? '% ' : '') + x.base) : '', hint = lead + (x.hint ? (lead ? ' · ' : '') + x.hint : ''); h += row(esc(x.label), x.count, x.pct == null ? '' : x.pct + '%', x.tone, { hint: esc(hint), sub: !!x.sub }); });
      h += '</div>';
      var red = function (v, bad, strong) { return '<span style="' + (bad ? 'color:var(--ds-danger);font-weight:800' : '') + '">' + (v == null ? '—' : v + '%') + '</span>'; };
      var cells = function (x, label) {
        return { tot: label === 'Total', c: [label, num(x.cod), red(x.attempted_pct, x.attempted_pct != null && x.attempted_pct < 100 && !x.is_today), num(x.attempted), num(x.connected), p1(x.connected_pct), num(x.not_connected), (x.is_today && x.not_attempted ? num(x.not_attempted) + ' (waiting)' : num(x.not_attempted)),
          num(x.cancelled), num(x.confirmed), red(x.confirmed_pct, false), num(x.open), p1(x.open_pct), num(x.prepaid)] };
      };
      h += '<div class="rp-what" style="margin-top:14px">Day by day, by order date. Every percentage is a share of that day\'s COD orders. Attempted % is red when a past day is below 100%. Prepaid is shown on its own and is not in any percentage.</div>' +
        table(['Order date', 'COD orders', 'Attempted %', 'Attempted', 'Connected', 'Connected %', 'Not connected', 'Not tried', 'Cancelled', 'Confirmed', 'Confirmed %', 'Still open', 'Open %', 'Prepaid (not counted)'],
          trs(e.days.map(function (x) { return cells(x, esc(nice(x.day))); }).concat([cells(e.totals, 'Total')])));
      h += '<div class="rp-what" style="margin-top:6px">Connected = the customer answered on any channel (a call, an IVR key, a WhatsApp reply); an address fix counts as connected and confirmed. Not connected = tried, nobody answered (no answer, switched off, not reachable). Cancelled = the customer refused. Not tried = no channel has tried yet. Connected + not connected + not tried = COD orders.</div>';
      return h;
    }
    function render(d) {
      var c = d.cohort, a = d.activity, p = d.backlog.pipeline, age = d.backlog.uncalled_age, T = c.total_orders;
      el.querySelector('#rpSub').textContent = nice(d.from) + (d.from === d.to ? '' : ' to ' + nice(d.to)) + ' · ' + (d.team === 'all' ? 'All teams' : d.team === 'CC' ? 'Call centre' : 'Aman') + ' · India time';
      var h = '';
      var cs = d.calling_since, day = function (iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); };
      var sinceDay = d.team === 'CC' ? day(cs.call_centre) : d.team === 'InHouse' ? day(cs.aman) : [day(cs.call_centre), day(cs.aman)].sort()[1];
      if (cs && d.from < sinceDay) h += '<div class="rp-recon" style="background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.45);color:var(--ds-warn-ink)"><b>Calling in the CRM started on ' + esc(nice(sinceDay)) + '.</b> Orders placed before that date have no call history here, so their "not called yet" numbers are not real. For clean numbers choose dates from ' + esc(nice(sinceDay)) + ' onwards. "Open right now" already ignores those older orders.</div>';
      h += d.cod_all ? codHtml(d.cod_all) : e2eHtml(d.e2e);
      // Headline: the two different things people mix up, side by side
      h += '<div class="rp-grid" style="margin-top:8px">' +
        tile('Orders placed in these dates', T, 'new orders that came in', '') +
        tile('Orders dialled in these dates', a.orders_dialled, num(a.calls_on_period_orders) + ' calls on the new orders · ' + num(a.calls_on_older_orders) + ' calls on older orders', 'ok') +
        tile('Calls made in these dates', a.calls, a.picked_pct + '% picked up', '') + '</div>';
      if (d.analysis) h += overviewHtml(d.analysis);
      // (old section A removed 2026-11-25: its call-only numbers duplicated the End to end block above with a different meaning of connected; the retry rows now sit in that block)
      // B
      h += '<h3><b>A.</b> Calls made in these dates</h3><div class="rp-what">Every call the team made on the chosen dates, on any order. These are calls, not orders.</div><div class="rp-grid">' +
        tile('Calls made', a.calls, num(a.orders_dialled) + ' different orders dialled', '') +
        tile('Picked up', a.picked, a.picked_pct + '% of calls', 'ok') +
        tile('No answer', a.no_answer, pct(a.no_answer, a.calls) + ' of calls', a.no_answer ? 'warn' : '') +
        tile('Confirmed on a call', a.confirmed, 'orders confirmed', 'ok') +
        tile('Cancelled on a call', a.cancelled, 'orders cancelled', 'bad') +
        tile('Callbacks set', a.callbacks, 'calls', '') + tile('Address fixes', a.address_fix, 'calls', '') + tile('Wrong numbers', a.wrong_number, 'orders', '') + '</div>' +
        '<div class="rp-recon"><b>' + num(a.calls) + '</b> calls made = <b>' + num(a.calls_on_period_orders) + '</b> on orders placed in these dates + <b>' + num(a.calls_on_older_orders) + '</b> on older orders.</div>';
      // C
      h += '<h3><b>B.</b> Open right now (all dates)</h3><div class="rp-what">What is waiting for a call today, regardless of the dates above (last ' + d.backlog.window_days + ' days of orders).</div><div class="rp-grid">' +
        tile('To call now', p.to_call_now, 'fresh + not connected + callbacks due', 'warn', 'to_call_now') +
        tile('Fresh, not called', p.fresh, num(Math.min(p.fresh, (d.backlog.fresh_why || {}).ready_in_fresh_list || 0)) + ' ready in the Fresh list · ' + num(Math.max(0, p.fresh - ((d.backlog.fresh_why || {}).ready_in_fresh_list || 0))) + ' held (repeat / earlier order / duplicate)<br>By age: ' + num(age.under_1d) + ' under 1 day · ' + num(age.d1_to_3) + ' 1–3 days · ' + num(age.over_3d) + ' over 3 days', p.fresh ? 'warn' : '', 'fresh') +
        tile('Not connected', p.not_connected, num(p.nc_1) + ' with 1 call · ' + num(p.nc_2) + ' with 2 · ' + num(p.nc_3_plus) + ' with 3+', '', 'not_connected') +
        tile('Callbacks due', p.callback_due, num(p.callback_later) + ' later', p.callback_due ? 'bad' : '', 'callback_due') +
        tile('Short address, open', p.short_open, num(p.short_open_confirmed) + ' already confirmed', p.short_open ? 'warn' : '', 'short_open') + '</div>';
      // tables
      if (d.analysis) h += analysisHtml(d.analysis);
      h += '<h3>By call date</h3>' + table(['Call date', 'Calls made', 'Orders dialled', 'Picked up', 'Picked %', 'Confirmed', 'Cancelled', 'On these dates\' orders', 'On older orders'],
        d.by_call_day.map(function (x) { return '<tr><td>' + esc(nice(x.day)) + '</td><td>' + num(x.calls) + '</td><td>' + num(x.orders_dialled) + '</td><td>' + num(x.picked) + '</td><td>' + pct(x.picked, x.calls) + '</td><td>' + num(x.confirmed) + '</td><td>' + num(x.cancelled) + '</td><td>' + num(x.calls_on_period_orders) + '</td><td>' + num(x.calls - x.calls_on_period_orders) + '</td></tr>'; }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--ds-muted)">No calls on these dates</td></tr>');
      h += '<h3>By person (calls made)</h3>' + table(['Person', 'Team', 'Calls made', 'Orders dialled', 'Picked up', 'Picked %', 'No answer', 'Confirmed', 'Cancelled', 'Callbacks', 'Address fixes', 'Wrong no.', 'On these dates\' orders', 'On older orders'],
        d.by_agent.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + (x.team === 'CC' ? 'Call centre' : 'Aman') + '</td><td>' + num(x.calls) + '</td><td>' + num(x.orders_dialled) + '</td><td>' + num(x.picked) + '</td><td>' + pct(x.picked, x.calls) + '</td><td>' + num(x.no_answer) + '</td><td>' + num(x.confirmed) + '</td><td>' + num(x.cancelled) + '</td><td>' + num(x.callbacks) + '</td><td>' + num(x.address_fix) + '</td><td>' + num(x.wrong_number) + '</td><td>' + num(x.calls_on_period_orders) + '</td><td>' + num(x.calls - x.calls_on_period_orders) + '</td></tr>'; }).join('') || '<tr><td colspan="14" style="text-align:center;color:var(--ds-muted)">No calls on these dates</td></tr>');
      if (d.freshness) {
        var w = d.not_called_why || {}, ago = function (iso) { if (!iso) return 'never'; var m = Math.round((Date.now() - new Date(iso)) / 60000); var when = new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); return when + ' (' + (m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago') + ')'; };
        h += '<h3><b>C.</b> Data check</h3><div class="rp-what">Why some orders are not called yet, and how fresh the data is. Use this to spot a stopped feed or a team that is not logging calls.</div><div class="rp-card">' +
          '<div class="rp-row hd"><div>Orders placed in these dates that nobody has called</div><div style="text-align:right">Orders</div><div></div></div>' +
          row('Waiting in the agents\' Fresh list', w.ready_in_fresh_list || 0, '', (w.ready_in_fresh_list || 0) ? 'warn' : '', { hint: 'these are the ones to call' }) +
          row('Held: repeat customer', w.repeat_customer || 0, '', '', { hint: 'goes to Aman\'s repeat queue, not the Fresh list' }) +
          row('Held: earlier order from the same phone', w.earlier_order_same_phone || 0, '', '', { hint: 'not shown in the Fresh list' }) +
          row('Held: duplicate order', w.duplicate || 0, '', '', { hint: 'waits in duplicate review' }) +
          row('Callback booked', w.callback_set || 0, '') +
          row('Do not call', w.dnc || 0, '') +
          row('Shipped, or status is not "new"', w.not_new_or_shipped || 0, '') +
          row('Already confirmed / cancelled without a call', w.closed_without_call || 0, '', '', { hint: 'WhatsApp, IVR, sheet or auto' }) +
          '</div><div class="rp-card" style="margin-top:9px">' +
          '<div class="rp-row hd"><div>Latest activity seen in the CRM</div><div></div><div></div></div>' +
          '<div class="rp-row"><div class="l">Last order received</div><div class="p" style="grid-column:2 / 4;text-align:right">' + esc(ago(d.freshness.last_order)) + '</div></div>' +
          '<div class="rp-row"><div class="l">Last call logged - call centre</div><div class="p" style="grid-column:2 / 4;text-align:right">' + esc(ago(d.freshness.last_cc_call)) + '</div></div>' +
          '<div class="rp-row"><div class="l">Last call logged - Aman</div><div class="p" style="grid-column:2 / 4;text-align:right">' + esc(ago(d.freshness.last_aman_call)) + '</div></div>' +
          '<div class="rp-row"><div class="l">Last WhatsApp / IVR / sheet update</div><div class="p" style="grid-column:2 / 4;text-align:right">' + esc(ago(d.freshness.last_sheet_event)) + '</div></div></div>';
        var role = function (rs, a) { if (!rs || !rs.length) return /whatsapp|ivr|sheet|system|payment|auto/i.test(a) ? 'Automatic (' + a + ')' : 'Not a CRM login'; return rs.map(function (x) { return x === 'agent' ? 'Call centre' : x === 'aman' ? 'Aman' : x === 'admin' ? 'Admin' : x; }).join(' + '); };
        h += '<div class="rp-what" style="margin-top:12px">Who confirmed or cancelled orders on these dates, by name. If one name shows two account types, two logins share it and their numbers get mixed.</div>' +
          table(['Name', 'Account type', 'Confirmed', 'Cancelled'], (d.deciders || []).map(function (x) { return '<tr><td>' + esc(x.actor) + '</td><td style="text-align:left">' + esc(role(x.roles, x.actor)) + (x.roles && x.roles.length > 1 ? ' <b style="color:var(--ds-warn-ink)">(shared name)</b>' : '') + '</td><td>' + num(x.confirmed) + '</td><td>' + num(x.cancelled) + '</td></tr>'; }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--ds-muted)">No confirmations or cancellations on these dates</td></tr>');
      }
      h += '<h3>How to read this report</h3><ul class="rp-def">' + d.definitions.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
      el.querySelector('#rpBody').innerHTML = h;
    }

    function autopilotCard(d) {
      var P = d.presence, pc = d.pace, who = (d.people || []).map(function (x) { return '<span class="' + (x.active ? 'rp-recon' : '') + '" style="display:inline-block;margin:2px 6px 2px 0;padding:3px 9px;border-radius:999px;font-size:0.75rem;' + (x.active ? '' : 'background:var(--ds-border);color:var(--ds-muted)') + '">' + esc(x.name) + ' (' + (x.team === 'cc' ? 'call centre' : 'Aman') + ') ' + (x.active ? 'working' : 'not here') + '</span>'; }).join('');
      var reasons = { cover_absent: 'covering an absent team', cc_failed: 'call centre could not reach', overflow_uncalled: 'never called for 24 h', deadline_overflow: '2 PM target at risk' };
      var mv = Object.keys(d.moves_today || {}).map(function (k) { return num(d.moves_today[k]) + ' ' + (reasons[k] || esc(k)); }).join(' · ') || 'none';
      var lr = d.last_run ? 'Last check ' + new Date(d.last_run.ran_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) + ': planned ' + num(d.last_run.planned) + ', moved ' + num(d.last_run.moved) : 'No check recorded yet';
      function paceRow(label, p) { return '<div class="rp-row"><div class="l">' + label + '<small>' + (p.phase === 'active' ? 'need ' + num(p.needed_per_hour) + ' an hour, doing ' + num(p.rate_per_hour) + ', ' + num(p.active_agents) + ' working' : p.phase === 'before' ? 'pace check starts at 11:00' : 'deadline passed') + '</small></div><div class="n ' + (p.behind ? 'bad' : '') + '">' + num(p.uncalled) + '</div><div class="p">' + (p.phase === 'after' ? (p.uncalled ? 'missed' : 'met') : p.behind ? 'behind ' + num(p.deficit) : 'on track') + '</div></div>'; }
      return '<h3><b>E.</b> Autopilot</h3><div class="rp-what">Mode: <b>' + (d.mode === 'on' ? 'on (it moves leads)' : d.mode === 'dry' ? 'planning only (it records what it would do, moves nothing)' : 'off') + '</b>. First call needed by ' + d.rules.deadline_hour + ':00 for every order placed before ' + d.rules.cutoff_hour + ':00. Shift ' + esc(d.rules.shift) + '. Hand-over to Aman after ' + d.rules.fail_attempts + ' unanswered tries over ' + d.rules.fail_days + ' days, or ' + d.rules.fail_hours + ' h without reaching the customer.</div>' +
        '<div class="rp-card"><div class="rp-row hd"><div>First calls still needed for the target</div><div style="text-align:right">Orders</div><div style="text-align:right">Status</div></div>' + paceRow('Call centre', pc.cc) + paceRow('Aman', pc.aman) + '</div>' +
        '<div style="margin:10px 0">' + (who || '<span class="lab">No people listed.</span>') + '</div><div class="rp-what">Leads moved today: <b>' + mv + '</b>. ' + lr + '. Connectivity today ' + (d.connectivity.pct == null ? '—' : d.connectivity.pct + '%') + ' against a target of ' + d.connectivity.target + '%.</div>';
    }
    function loadAutopilot() {
      fetch('/api/cc/autopilot/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) return; var body = el.querySelector('#rpBody'); if (body) body.insertAdjacentHTML('beforeend', autopilotCard(d));
      }).catch(function () {});
    }
    function load() {
      var r = range();
      if (!r.from || !r.to) return;
      el.querySelector('#rpBody').innerHTML = '<div class="rp-load">Loading…</div>';
      fetch('/api/cc/report?from=' + r.from + '&to=' + r.to + '&team=' + encodeURIComponent(S.team)).then(function (res) {
        if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not load the report'); return j; });
      }).then(function (d) { render(d); loadAutopilot(); }).catch(function (e) { if (e.message !== 'login') el.querySelector('#rpBody').innerHTML = '<div class="rp-err">' + esc(e.message) + '</div>'; });
    }
    el.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-s');
      if (k === 'period') { S.period = e.target.value; el.querySelector('[data-s="custom"]').style.display = S.period === 'custom' ? 'inline' : 'none'; if (S.period !== 'custom') load(); }
      else if (k === 'team') { S.team = e.target.value; load(); }
      else if (k === 'from') S.from = e.target.value; else if (k === 'to') S.to = e.target.value;
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-s],[data-open]'); if (!b) return;
      if (b.getAttribute('data-s') === 'apply') load();
      else if (b.getAttribute('data-s') === 'xls') { var r = range(); location.href = opt.excel + '?from=' + r.from + '&to=' + r.to + '&team=' + encodeURIComponent(S.team); }
      else if (b.getAttribute('data-open') && opt.openList) opt.openList(b.getAttribute('data-open'), { from: addDays(today(), -44), to: today() }, S.team, '', b.querySelector('.l').textContent);
    });
    load();
    return { refresh: load };
  }
  window.ReportUI = { mount: mount };
})();
