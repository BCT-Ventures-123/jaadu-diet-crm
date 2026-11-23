/* Owner scoreboard / team score. Data: /api/cc/scoreboard. Works on phone and laptop.
   ScoreboardUI.mount(el, { view: 'all' | 'aman' | 'cc', title }) */
(function () {
  var TZ = 'Asia/Kolkata';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

  var css = '' +
    '.sb{color:var(--ds-text);font-family:inherit;padding:14px 16px}.sb *{box-sizing:border-box}' +
    '.sb-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}.sb-title{font-size:1rem;font-weight:800}.sb-title small{display:block;font-size:0.75rem;font-weight:500;color:var(--ds-muted);margin-top:2px}' +
    '.sb select{background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:9px 10px;border-radius:9px;font-size:0.875rem;font-family:inherit}' +
    '.sb h3{font-size:0.75rem;text-transform:uppercase;letter-spacing:.8px;color:var(--ds-muted);margin:20px 0 9px;font-weight:700}' +
    '.sb-total{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}.sb-total b{font-size:1.75rem;font-weight:800;line-height:1}.sb-total span{color:var(--ds-muted);font-size:0.75rem}' +
    '.sb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}' +
    '.sb-tile{background:var(--ds-surface-2);border:1px solid var(--ds-border);border-radius:13px;padding:12px 13px}.sb-tile .l{font-size:0.75rem;text-transform:uppercase;letter-spacing:.5px;color:var(--ds-muted);font-weight:700}' +
    '.sb-tile .v{font-size:1.75rem;font-weight:800;margin:3px 0 2px;line-height:1.1}.sb-tile .c{font-size:0.75rem;color:var(--ds-muted)}' +
    '.sb-tile.ok{border-color:rgba(16,185,129,.55)}.sb-tile.ok .v{color:var(--ds-brand)}.sb-tile.bad{border-color:rgba(239,68,68,.65);background:rgba(239,68,68,.07)}.sb-tile.bad .v{color:var(--ds-danger)}.sb-tile.warn{border-color:rgba(245,158,11,.6)}.sb-tile.warn .v{color:var(--ds-warn-ink)}' +
    '.sb-tile .c b{color:var(--ds-text)}' +
    '.sb-row{display:grid;grid-template-columns:128px 1fr 74px;gap:9px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(30,45,74,.55);font-size:0.875rem}.sb-row .bar{height:9px;background:var(--ds-border);border-radius:5px;overflow:hidden;display:flex}' +
    '.sb-row .bar i{display:block;height:100%}.sb-row .bar .cf{background:var(--ds-brand)}.sb-row .bar .cx{background:var(--ds-danger)}.sb-row .bar .nr{background:var(--ds-faint)}.sb-row .n{text-align:right;font-weight:800}.sb-row .n small{display:block;color:var(--ds-muted);font-weight:600;font-size:0.75rem}' +
    '.sb-row .nm{font-weight:700}.sb-row .nm small{display:block;color:var(--ds-muted);font-weight:500;font-size:0.75rem}' +
    '.sb-legend{display:flex;gap:14px;font-size:0.75rem;color:var(--ds-muted);margin-top:6px}.sb-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}' +
    '.sb-att{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:7px}.sb-att li{background:var(--ds-surface-2);border:1px solid var(--ds-border);border-left-width:4px;border-radius:10px;padding:10px 12px;font-size:0.875rem;line-height:1.4}.sb-att li.bad{border-left-color:var(--ds-danger)}.sb-att li.warn{border-left-color:var(--ds-warn-ink)}' +
    '.sb-good{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.45);color:var(--ds-brand);border-radius:10px;padding:10px 12px;font-size:0.875rem}' +
    '.sb-tw{overflow-x:auto;border:1px solid var(--ds-border);border-radius:12px}.sb table{width:100%;border-collapse:collapse;font-size:0.75rem;min-width:640px}.sb th{background:var(--ds-surface-2);color:var(--ds-faint);text-transform:uppercase;font-size:0.75rem;letter-spacing:.6px;padding:9px 10px;text-align:right;white-space:nowrap}' +
    '.sb th:first-child,.sb td:first-child{text-align:left}.sb td{padding:9px 10px;text-align:right;border-top:1px solid rgba(30,45,74,.6);white-space:nowrap}.sb td.ok{color:var(--ds-brand);font-weight:700}.sb td.bad{color:var(--ds-danger);font-weight:700}.sb td.warn{color:var(--ds-warn-ink);font-weight:700}' +
    '.sb-note{font-size:0.75rem;color:var(--ds-muted);margin-top:8px;line-height:1.5}.sb-load{padding:30px;text-align:center;color:var(--ds-muted)}.sb-err{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);color:var(--ds-warn-ink);border-radius:10px;padding:10px 12px;font-size:0.75rem}' +
    '@media(max-width:560px){.sb{padding:12px 10px}.sb-row{grid-template-columns:96px 1fr 62px}.sb-total b{font-size:1.75rem}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var CH = [['whatsapp', 'WhatsApp', 'customer clicked'], ['ivr', 'IVR', 'after 6 PM'], ['cc', 'Call centre', 'agent calls'], ['aman', 'Aman', 'in-house calls'], ['other', 'Other', 'sheet / payment / admin']];

  function mount(el, opt) {
    opt = opt || {};
    var S = { period: opt.period || 'last7' };
    el.classList.add('sb');
    el.innerHTML = '<div class="sb-top"><div class="sb-title">' + esc(opt.title || 'Scoreboard') + '<small id="sbSub"></small></div>' +
      '<select data-s="period"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option><option value="last10">Last 10 days</option><option value="last30">Last 30 days</option></select></div>' +
      '<div id="sbBody"><div class="sb-load">Loading…</div></div>';
    el.querySelector('[data-s="period"]').value = S.period;

    function range() {
      var t = today();
      switch (S.period) {
        case 'today': return { from: t, to: t };
        case 'yesterday': var y = addDays(t, -1); return { from: y, to: y };
        case 'last3': return { from: addDays(t, -2), to: t };
        case 'last10': return { from: addDays(t, -9), to: t };
        case 'last30': return { from: addDays(t, -29), to: t };
        default: return { from: addDays(t, -6), to: t };
      }
    }
    function tile(label, value, caption, cls) { return '<div class="sb-tile ' + (cls || '') + '"><div class="l">' + label + '</div><div class="v">' + value + '</div><div class="c">' + caption + '</div></div>'; }
    function good(v, ok, warnBelow) { return ok ? 'ok' : (warnBelow !== undefined && v >= warnBelow ? 'warn' : 'bad'); }

    function receivedSection(r) {
      var nice = function (iso) { return new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }); };
      var html = '<h3>Orders received</h3><div class="sb-total"><b>' + num(r.total) + '</b><span>orders in this period · <b style="color:var(--ds-text)">' + num(r.cod) + ' COD</b> + <b style="color:var(--ds-text)">' + num(r.prepaid) + ' prepaid</b></span></div>';
      if (r.days.length > 1) {
        html += '<div class="sb-tw"><table style="min-width:420px"><thead><tr><th>Date</th><th>Total orders</th><th>COD</th><th>Prepaid</th></tr></thead><tbody>' +
          r.days.map(function (d) { return '<tr><td>' + esc(nice(d.day)) + '</td><td><b>' + num(d.total) + '</b></td><td>' + num(d.cod) + '</td><td>' + num(d.prepaid) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }
      html += '<div class="sb-note">' + (r.converted ? num(r.converted) + ' of the COD orders were converted to prepaid by agents. ' : '') +
        'Left out: ' + num(r.left_out.test) + ' test orders and ' + num(r.left_out.other) + ' orders under ₹' + r.left_out.min_price + ' or not one of our teas. The goal below counts COD orders only.</div>';
      return html;
    }

    function distributionSection(list) {
      var cols = ['orders', 'called', 'not_called', 'connected', 'confirmed', 'cancelled', 'not_connected', 'dials', 'dials_orders', 'dials_picked'];
      var tot = {}; cols.forEach(function (k) { tot[k] = list.reduce(function (s, x) { return s + (x[k] || 0); }, 0); });
      function tr(x, bold) {
        return '<tr' + (bold ? ' style="font-weight:800;background:var(--ds-surface-2)"' : '') + '><td>' + esc(x.label) + '</td><td>' + num(x.orders) + '</td><td>' + num(x.called) + '</td><td class="' + (x.not_called ? 'warn' : '') + '">' + num(x.not_called) + '</td><td>' + num(x.connected) + '</td><td class="ok">' + num(x.confirmed) + '</td><td class="bad">' + num(x.cancelled) + '</td><td>' + num(x.not_connected) + '</td>' +
          '<td style="border-left:1px solid var(--ds-border)">' + num(x.dials) + '</td><td>' + num(x.dials_orders) + '</td><td>' + num(x.dials_picked) + '</td></tr>';
      }
      var rows = list.map(function (x) { return tr(x); }).join('') + (list.length > 1 ? tr(Object.assign({ label: 'Total' }, tot), true) : '');
      return '<h3>Orders given to each team</h3><div class="sb-tw"><table style="min-width:760px"><thead><tr><th>Team</th><th>Orders given</th><th>Called</th><th>Not called yet</th><th>Connected</th><th>Confirmed</th><th>Cancelled</th><th>Not connected</th><th style="border-left:1px solid var(--ds-border)">Dials made</th><th>Orders dialled</th><th>Dials picked</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="sb-note"><b>Orders given</b> = COD orders that came in during the dates above, by the team they were given to. <b>Called</b> = of those, how many have had at least one call; <b>Not called yet</b> = the rest. ' +
        '<b>Dials made</b> = calls the team made on those dates (on any order, new or old), <b>Orders dialled</b> = different orders called, <b>Dials picked</b> = calls where the customer spoke.</div>';
    }
    function goalSection(g) {
      var T = g.targets, s = g.status;
      var gapTxt = function (st, what) { return st.ok ? '<b>Target met</b>' : '<b>' + num(st.gap) + ' orders ' + what + '</b>'; };
      var html = '<h3>Goal</h3><div class="sb-total"><b>' + num(g.total) + '</b><span>COD orders placed in this period</span></div><div class="sb-grid">' +
        tile('Reached', g.reached_pct + '%', 'Target ' + T.reached + '% · ' + gapTxt(s.reached, 'short'), good(g.reached_pct, s.reached.ok, T.reached - 3)) +
        tile('Cancelled', g.cancelled_pct + '%', 'Max ' + T.cancelled_max + '% · ' + (s.cancelled.ok ? '<b>Within limit</b>' : '<b>' + num(s.cancelled.gap) + ' too many</b>'), s.cancelled.ok ? 'ok' : 'bad') +
        tile('Not reached', g.not_reached_pct + '%', 'Max ' + T.not_reached_max + '% · ' + (s.not_reached.ok ? '<b>Within limit</b>' : '<b>' + num(s.not_reached.gap) + ' too many</b>') + (g.auto_cancelled ? ' · incl. ' + g.auto_cancelled + ' auto-cancelled' : ''), s.not_reached.ok ? 'ok' : 'bad') +
        '</div>';
      var max = Math.max(1, g.total);
      html += '<h3>Who decided the orders</h3>' + CH.map(function (c) {
        var d = g.by_channel[c[0]], n = d.confirmed + d.cancelled;
        return '<div class="sb-row"><div class="nm">' + c[1] + '<small>' + c[2] + '</small></div><div class="bar"><i class="cf" style="width:' + (d.confirmed / max * 100) + '%"></i><i class="cx" style="width:' + (d.cancelled / max * 100) + '%"></i></div>' +
          '<div class="n">' + num(n) + '<small>' + (g.total ? Math.round(n / g.total * 1000) / 10 : 0) + '% of orders</small></div></div>';
      }).join('') +
        '<div class="sb-row"><div class="nm">Not reached<small>no customer answer</small></div><div class="bar"><i class="nr" style="width:' + (g.not_reached / max * 100) + '%"></i></div><div class="n">' + num(g.not_reached) + '<small>' + g.not_reached_pct + '% of orders</small></div></div>' +
        '<div class="sb-legend"><span><i style="background:var(--ds-brand)"></i>confirmed</span><span><i style="background:var(--ds-danger)"></i>cancelled</span><span><i style="background:var(--ds-faint)"></i>not reached</span></div>';
      return html;
    }

    function teamSection(t) {
      var T = { redial: 85, confirm: 65 };
      var rd = t.redial.pct;
      return '<div class="sb-grid" style="margin-bottom:10px">' +
        tile(t.label + ' calls', num(t.calls), num(t.orders_called) + ' orders called · ' + t.spoke_pct + '% answered', '') +
        tile('Confirm rate', t.confirm_pct + '%', 'of customers spoken to · should be ' + T.confirm + '%+', good(t.confirm_pct, t.spoke < 10 || t.confirm_pct >= T.confirm, 50)) +
        tile('Redial rate', rd === null ? '—' : rd + '%', rd === null ? 'no no-answer orders old enough yet' : '<b>' + t.redial.missed + ' not called again</b> in 24h · should be 85%+', rd === null ? '' : good(rd, rd >= T.redial, 70)) +
        tile('Fresh, no call 24h+', num(t.backlog.fresh_waiting), 'orders nobody has called', t.backlog.fresh_waiting ? 'bad' : 'ok') +
        tile('Late callbacks', num(t.backlog.callbacks_overdue), 'promised, over 2 hours late', t.backlog.callbacks_overdue ? 'warn' : 'ok') +
        tile('Cancel rate', t.cancel_pct + '%', 'of customers spoken to', '') + '</div>';
    }

    function peopleTable(people) {
      if (!people.length) return '';
      var cls = function (ok, warn) { return ok ? 'ok' : warn ? 'warn' : 'bad'; };
      return '<div class="sb-tw"><table><thead><tr><th>Person</th><th>Calls</th><th>Answered</th><th>Confirm %</th><th>Cancel %</th><th>No-answer %</th><th>Redial %</th><th>Wrong no. %</th></tr></thead><tbody>' +
        people.map(function (p) {
          var rd = p.redial.pct;
          return '<tr><td>' + esc(p.name) + ' <small style="color:var(--ds-muted)">' + (p.team === 'aman' ? 'Aman' : 'Call centre') + '</small></td><td>' + num(p.calls) + '</td><td>' + p.spoke_pct + '%</td>' +
            '<td class="' + cls(p.spoke < 10 || p.confirm_pct >= 65, p.confirm_pct >= 50) + '">' + p.confirm_pct + '%</td>' +
            '<td class="' + (p.spoke >= 20 && p.cancel_pct >= 12 ? 'bad' : '') + '">' + p.cancel_pct + '%</td>' +
            '<td class="' + (p.calls >= 30 && p.dnp_pct >= 60 ? 'bad' : '') + '">' + p.dnp_pct + '%</td>' +
            '<td class="' + (rd === null ? '' : cls(rd >= 85, rd >= 70)) + '">' + (rd === null ? '—' : rd + '%') + '</td>' +
            '<td class="' + (p.orders_called >= 20 && p.wrong_pct >= 8 ? 'warn' : '') + '">' + p.wrong_pct + '%</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function render(d) {
      el.querySelector('#sbSub').textContent = d.from + (d.from === d.to ? '' : ' to ' + d.to) + ' · COD orders only';
      var html = '';
      if (d.orders_received) html += receivedSection(d.orders_received);
      if (d.distribution && d.distribution.length) html += distributionSection(d.distribution);
      if (d.goal) html += goalSection(d.goal);
      html += '<h3>Needs attention</h3>' + (d.attention.length
        ? '<ul class="sb-att">' + d.attention.map(function (a) { return '<li class="' + a.level + '">' + esc(a.text) + '</li>'; }).join('') + '</ul>'
        : '<div class="sb-good">Nothing to flag in this period.</div>');
      Object.keys(d.teams).forEach(function (k) { html += '<h3>' + esc(d.teams[k].label) + '</h3>' + teamSection(d.teams[k]); });
      html += '<h3>' + (d.view === 'all' ? 'By person' : 'My numbers') + '</h3>' + (d.people.length ? peopleTable(d.people) : '<div class="sb-note">No calls in this period.</div>');
      html += '<div class="sb-note">Redial rate = of the orders where the customer did not pick up, how many were called again within 24 hours (orders confirmed or cancelled by another channel in that time are not counted against the caller). ' +
        (d.goal ? 'Reached = the customer answered on any channel (WhatsApp, IVR, a call). Orders cancelled automatically because nobody was reached count as not reached. Orders placed today are still being confirmed and shipped.' : '') + '</div>';
      el.querySelector('#sbBody').innerHTML = html;
    }

    function load() {
      var r = range();
      el.querySelector('#sbBody').innerHTML = '<div class="sb-load">Loading…</div>';
      return fetch('/api/cc/scoreboard?from=' + r.from + '&to=' + r.to + '&view=' + (opt.view || 'all')).then(function (res) {
        if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || ('Error ' + res.status)); return j; });
      }).then(render).catch(function (e) { if (e.message !== 'login') el.querySelector('#sbBody').innerHTML = '<div class="sb-err">Could not load: ' + esc(e.message) + '</div>'; });
    }
    el.addEventListener('change', function (e) { if (e.target.getAttribute('data-s') === 'period') { S.period = e.target.value; load(); } });
    load();
    return { refresh: load };
  }
  window.ScoreboardUI = { mount: mount };
})();
