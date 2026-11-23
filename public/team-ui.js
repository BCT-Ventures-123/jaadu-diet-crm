/* Admin "Team performance" tab. Four separate measures: Aman, Call centre, Both callers together, All channels together.
   Data: /api/cc/team-report (rules in lib/teamReport.js). Uses helpers from admin.html ($, esc). */
(function () {
  var TZ = 'Asia/Kolkata';
  var tabsEl = $('tabs'), anchor = $('p-log');
  var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = 'teamperf'; t.textContent = 'Team performance';
  tabsEl.insertBefore(t, tabsEl.children[1] || null);
  var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-teamperf'; anchor.parentNode.appendChild(p);

  var css = '.tp{padding:6px 0 28px;color:var(--ds-text)}.tp-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.tp-title{font-size:1.25rem;font-weight:800;margin-right:auto}' +
    '.tp select,.tp input[type=date]{background:var(--ds-surface);border:1px solid var(--ds-border-strong);color:var(--ds-text);padding:8px 10px;border-radius:8px;font-size:0.875rem;font-family:inherit}' +
    '.tp-btn{background:var(--ds-brand);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit}.tp-btn.alt{background:var(--ds-surface);color:var(--ds-text);border:1px solid var(--ds-border-strong)}' +
    '.tp-seg{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 4px}.tp-seg button{background:var(--ds-surface);border:1px solid var(--ds-border-strong);color:var(--ds-text);border-radius:8px;padding:10px 16px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit}' +
    '.tp-seg button.on{background:var(--ds-brand);border-color:var(--ds-brand);color:#fff}.tp-sub{font-size:0.75rem;color:var(--ds-muted);margin:2px 0 10px}' +
    '.tp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:10px 0 6px}.tp-tile{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:12px 14px}' +
    '.tp-tile .l{font-size:0.75rem;font-weight:700;color:var(--ds-muted)}.tp-tile .v{font-size:1.75rem;font-weight:800;line-height:1.15;margin:4px 0;font-variant-numeric:tabular-nums}.tp-tile .c{font-size:0.75rem;color:var(--ds-muted);line-height:1.4}' +
    '.tp-chip{display:inline-block;font-size:0.75rem;font-weight:700;border-radius:999px;padding:2px 9px;margin-top:6px;background:var(--ds-surface-2);color:var(--ds-muted)}.tp-tile.ok .v{color:var(--ds-brand)}.tp-tile.ok .tp-chip{background:var(--ds-brand-tint);color:var(--ds-brand-strong)}' +
    '.tp-tile.warn .v{color:var(--ds-warn-ink)}.tp-tile.warn .tp-chip{background:var(--ds-warn-tint);color:var(--ds-warn-ink)}.tp-tile.bad .v{color:var(--ds-danger)}.tp-tile.bad .tp-chip{background:var(--ds-danger-tint);color:var(--ds-danger)}' +
    '.tp h3{font-size:1rem;font-weight:800;margin:24px 0 4px}.tp-what{font-size:0.75rem;color:var(--ds-muted);margin-bottom:8px;line-height:1.5}' +
    '.tp-flags{list-style:none;margin:6px 0 0;padding:0}.tp-flags li{padding:9px 12px;border-radius:8px;margin-bottom:6px;font-size:0.875rem;line-height:1.45;background:var(--ds-surface);border:1px solid var(--ds-border)}' +
    '.tp-flags li.bad{background:var(--ds-danger-tint);border-color:#e8b4b4}.tp-flags li.warn{background:var(--ds-warn-tint);border-color:#ecd68a}.tp-flags li.good{background:var(--ds-brand-tint);border-color:#b9d9c5}' +
    '.tp-tw{overflow-x:auto;border:1px solid var(--ds-border);border-radius:8px;background:var(--ds-surface)}.tp table{width:100%;border-collapse:collapse;font-size:0.875rem;min-width:640px}' +
    '.tp th{background:var(--ds-surface-2);color:var(--ds-muted);font-size:0.75rem;font-weight:700;padding:9px 10px;text-align:right;white-space:nowrap}.tp td{padding:9px 10px;text-align:right;border-top:1px solid var(--ds-border);white-space:nowrap;font-variant-numeric:tabular-nums}' +
    '.tp th:first-child,.tp td:first-child{text-align:left}.tp tr.tot td{font-weight:800;background:var(--ds-surface-2)}.tp td.bad{color:var(--ds-danger);font-weight:800}.tp td.ok{color:var(--ds-brand);font-weight:700}' +
    '.tp-bar{display:inline-block;height:8px;border-radius:4px;background:var(--ds-brand);vertical-align:middle;margin-left:8px;min-width:1px}.tp-def{font-size:0.75rem;color:var(--ds-muted);line-height:1.6;margin:0;padding-left:18px}.tp-err{background:var(--ds-danger-tint);color:var(--ds-danger);border-radius:8px;padding:10px 12px}.tp-load{padding:30px;text-align:center;color:var(--ds-muted)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var S = { period: 'last7', view: 'aman', from: '', to: '' }, DATA = null;
  var VIEWS = [['aman', 'Aman'], ['cc', 'Call centre'], ['callers', 'Both callers'], ['channels', 'All channels']];
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function nice(iso) { return new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function pc(v) { return v == null ? '—' : v + '%'; }
  function range() {
    var d = today();
    switch (S.period) {
      case 'today': return { from: d, to: d };
      case 'yesterday': return { from: addDays(d, -1), to: addDays(d, -1) };
      case 'last3': return { from: addDays(d, -2), to: d };
      case 'last30': return { from: addDays(d, -29), to: d };
      case 'month': return { from: d.slice(0, 8) + '01', to: d };
      case 'custom': return { from: S.from, to: S.to };
      default: return { from: addDays(d, -6), to: d };
    }
  }
  function table(head, rows) { return '<div class="tp-tw"><table><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'; }
  function tr(cells, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map(function (c) { return '<td' + (c && c.cls ? ' class="' + c.cls + '"' : '') + '>' + (c && c.h !== undefined ? c.h : c) + '</td>'; }).join('') + '</tr>'; }
  var CHIP = { ok: 'On target', warn: 'Close to target', bad: 'Below target' };
  function tiles(kpis) {
    return '<div class="tp-grid">' + kpis.map(function (k) {
      return '<div class="tp-tile ' + (k.tone || '') + '"><div class="l">' + esc(k.label) + '</div><div class="v">' + (k.value == null ? '—' : esc(k.value) + esc(k.unit || '')) + '</div><div class="c">' + esc(k.caption) + '</div>' +
        (k.tone ? '<span class="tp-chip">' + CHIP[k.tone] + (k.target ? ' (target ' + esc(k.target) + ')' : '') + '</span>' : (k.target ? '<span class="tp-chip">target ' + esc(k.target) + '</span>' : '')) + '</div>';
    }).join('') + '</div>';
  }
  function flagsHtml(flags) {
    if (!flags.length) return '<ul class="tp-flags"><li class="good">Nothing needs attention for these dates.</li></ul>';
    return '<ul class="tp-flags">' + flags.map(function (f) { return '<li class="' + f.level + '"><b>' + (f.level === 'bad' ? 'Act: ' : 'Watch: ') + '</b>' + esc(f.text) + '</li>'; }).join('') + '</ul>';
  }

  function teamHtml(T) {
    var m = T.metrics, a = T.activity, h = '';
    h += '<div class="tp-what">' + esc(T.label) + '. Leads are the COD orders placed in these dates and given to ' + (T.key === 'callers' ? 'either caller team' : 'this team') + '. Is the team working every lead it owns?</div>' + tiles(T.kpis);
    h += '<h3>What to look at</h3>' + flagsHtml(T.flags);
    h += '<h3>Leads, step by step</h3><div class="tp-what">Each line is a count of leads and its share of the base shown.</div>' + table(['Step', 'Leads', '% of base', 'Base'], [
      tr(['Leads given to the team', num(m.leads), '100%', 'all leads']),
      tr(['Closed without a call (WhatsApp, IVR, sheet, system)', num(m.closed_without_call), pc(m.leads ? Math.round(m.closed_without_call * 1000 / m.leads) / 10 : null), 'leads']),
      tr(['Needed a call', num(m.needed), pc(m.leads ? Math.round(m.needed * 1000 / m.leads) / 10 : null), 'leads']),
      tr(['Called at least once by this team', num(m.attempted), { h: pc(m.attempted_pct), cls: m.attempted_pct != null && m.attempted_pct < 100 ? 'bad' : 'ok' }, 'needed a call']),
      tr(['Called only by the other team (handed over)', num(m.called_by_other_team_only), pc(m.needed ? Math.round(m.called_by_other_team_only * 1000 / m.needed) / 10 : null), 'needed a call']),
      tr(['Never called by anyone', { h: num(m.not_called), cls: m.not_called ? 'bad' : '' }, pc(m.not_called_pct), 'needed a call']),
      tr(['Customer reached (someone spoke)', num(m.connected), pc(m.connected_pct_of_attempted), 'called']),
      tr(['Not reached (called, nobody picked up)', num(m.not_connected), pc(m.not_connected_pct), 'called']),
      tr(['   of which called a second time', num(m.nc_2nd), pc(m.nc_2nd_pct), 'not reached']),
      tr(['   of which called a third time', num(m.nc_3rd), pc(m.nc_3rd_pct), 'not reached']),
      tr(['Confirmed by this team', num(m.confirmed_by), pc(m.confirmed_by_pct), 'leads']),
      tr(['Rejected (customer cancelled on a call)', num(m.rejected_by), pc(m.rejected_by_pct), 'leads']),
      tr(['Still pending', num(m.pending), pc(m.pending_pct), 'leads'])
    ].join(''));
    h += '<h3>Calls made in these dates</h3><div class="tp-what">Calls on any order made by this team on the chosen dates. These are calls, not orders.</div>' + tiles([
      { label: 'Calls made', value: num(a.calls), caption: num(a.orders_dialled) + ' different orders dialled' },
      { label: 'Picked up', value: a.picked_pct, unit: '%', caption: num(a.picked) + ' of ' + num(a.calls) + ' calls' },
      { label: 'Working days', value: a.active_days, caption: num(a.people) + ' people made calls' },
      { label: 'Address fixes', value: num(a.address_fix), caption: 'calls, counted as reached' }
    ]);
    if (T.people.length) {
      h += '<h3>By person</h3>' + table(['Person', 'Calls', 'Orders dialled', 'Picked up %', 'No answer %', 'Confirmed', 'Cancelled', 'Cancel % of spoke', 'Address fixes', 'Working days', 'Calls per day'],
        T.people.map(function (x) { return tr([esc(x.name), num(x.calls), num(x.orders_dialled), pc(x.picked_pct), pc(x.dnp_pct), num(x.confirmed), num(x.cancelled), pc(x.cancel_of_spoke_pct), num(x.address_fix), num(x.active_days), x.calls_per_day == null ? '—' : x.calls_per_day]); }).join(''));
    }
    var td = today();
    h += '<h3>Day by day, by order date</h3><div class="tp-what">Called % is red when a past day is below 100%: that is a day leads were missed. Today is still open.</div>' + table(['Order date', 'Leads', 'Needed a call', 'Called', 'Called %', 'Reached', 'Reached %', 'Confirmed by team', 'Confirmed %', 'Never called'],
      T.days.map(function (x) { var bad = x.attempted_pct != null && x.attempted_pct < 100 && x.day !== td; return tr([esc(nice(x.day)), num(x.leads), num(x.needed), num(x.attempted), { h: pc(x.attempted_pct), cls: bad ? 'bad' : '' }, num(x.connected), pc(x.connected_pct), num(x.confirmed_by), pc(x.confirmed_pct), num(x.not_called) + (x.day === td && x.not_called ? ' (waiting)' : '')]); }).join('') || tr(['No leads in these dates']));
    if (T.call_days.length) h += '<h3>Calls by call date</h3>' + table(['Call date', 'Calls made', 'Orders dialled', 'Picked up %'], T.call_days.map(function (x) { return tr([esc(nice(x.day)), num(x.calls), num(x.orders_dialled), pc(x.picked_pct)]); }).join(''));
    return h;
  }

  function channelsHtml(C) {
    var t = C.totals, h = '<div class="tp-what">' + esc(C.label) + '. Every COD order gets a WhatsApp message. Aman and the call centre call. From 6 PM the IVR calls when both callers are unavailable or no WhatsApp reply has come. Who confirmed the orders placed in these dates:</div>' + tiles(C.kpis);
    var maxShare = Math.max.apply(null, C.channels.map(function (x) { return x.share_of_confirmed_pct || 0; }).concat([1]));
    h += '<h3>Who confirmed</h3><div class="tp-what">Each channel, with its share of all confirmations and of all COD orders.</div>' + table(['Channel', 'Confirmed', '% of COD orders', '% of all confirmed', 'Cancelled', '% of COD orders'],
      C.channels.map(function (x) { return tr([esc(x.label), num(x.confirmed), pc(x.confirmed_pct_of_cod), '<span>' + pc(x.share_of_confirmed_pct) + '</span><span class="tp-bar" style="width:' + Math.round(((x.share_of_confirmed_pct || 0) / maxShare) * 120) + 'px"></span>', num(x.cancelled), pc(x.cancelled_pct_of_cod)]); })
        .concat([tr(['Total', num(t.confirmed_total), pc(C.confirmed_pct), '100%', num(Object.keys(t.cancelled).reduce(function (s, k) { return s + t.cancelled[k]; }, 0)), ''], 'tot')]).join(''));
    h += '<h3>Reached and not reached</h3>' + table(['Measure', 'Orders', '% of COD orders'], [
      tr(['COD orders placed in these dates', num(t.cod), '100%']), tr(['Customers reached (WhatsApp, IVR or a call)', num(t.reached), pc(C.reached_pct)]),
      tr(['Not reached', num(t.not_reached), pc(C.not_reached_pct)]), tr(['Still pending', num(t.pending), pc(C.pending_pct)]),
      tr(['Cancelled automatically (nobody reached)', num(t.auto_cancelled), pc(t.cod ? Math.round(t.auto_cancelled * 1000 / t.cod) / 10 : null)])].join(''));
    h += '<h3>When the order was placed</h3><div class="tp-what">Orders placed from 6 PM fall in the IVR window.</div>' + table(['Placed', 'COD orders', 'Confirmed', 'Confirmed %', 'WhatsApp', 'IVR', 'Aman', 'Call centre', 'Other'],
      C.windows.map(function (x) { return tr([esc(x.label), num(x.orders), num(x.confirmed), pc(x.confirmed_pct), num(x.whatsapp), num(x.ivr), num(x.aman), num(x.cc), num(x.other)]); }).join(''));
    h += '<h3>Day by day, by order date</h3>' + table(['Order date', 'COD orders', 'Confirmed', 'Confirmed %', 'WhatsApp', 'IVR', 'Aman', 'Call centre', 'Other', 'Pending', 'Reached %'],
      C.days.map(function (x) { return tr([esc(nice(x.day)), num(x.cod), num(x.confirmed), pc(x.confirmed_pct), num(x.whatsapp), num(x.ivr), num(x.aman), num(x.cc), num(x.other), num(x.pending), pc(x.reached_pct)]); }).join('') || tr(['No orders in these dates']));
    return h;
  }

  function render() {
    var el = $('tp-body'); if (!DATA) return;
    $('tp-seg').innerHTML = VIEWS.map(function (v) { return '<button data-v="' + v[0] + '" class="' + (v[0] === S.view ? 'on' : '') + '">' + v[1] + '</button>'; }).join('');
    $('tp-sub').textContent = nice(DATA.from) + (DATA.from === DATA.to ? '' : ' to ' + nice(DATA.from === DATA.to ? DATA.to : DATA.to)) + ' · orders placed in these dates · India time';
    var T = DATA[S.view];
    el.innerHTML = (S.view === 'channels' ? channelsHtml(T) : teamHtml(T)) + '<h3>How to read this</h3><ul class="tp-def">' + DATA.definitions.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>';
  }
  function load() {
    var r = range(); if (!r.from || !r.to) return;
    $('tp-body').innerHTML = '<div class="tp-load">Loading…</div>';
    fetch('/api/cc/team-report?from=' + r.from + '&to=' + r.to).then(function (res) {
      if (res.status === 401) { location.href = '/login.html?next=/admin.html'; throw new Error('login'); }
      return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not load the report'); return j; });
    }).then(function (d) { DATA = d; render(); }).catch(function (e) { if (e.message !== 'login') $('tp-body').innerHTML = '<div class="tp-err">' + esc(e.message) + '</div>'; });
  }
  p.innerHTML = '<div class="tp"><div class="tp-top"><div class="tp-title">Team performance</div>' +
    '<select id="tp-period"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7" selected>Last 7 days</option><option value="last30">Last 30 days</option><option value="month">This month</option><option value="custom">Custom dates</option></select>' +
    '<span id="tp-custom" style="display:none"><input type="date" id="tp-from"> to <input type="date" id="tp-to"> <button class="tp-btn alt" id="tp-apply">Apply</button></span>' +
    '<button class="tp-btn" id="tp-xls">Download Excel</button></div><div class="tp-seg" id="tp-seg"></div><div class="tp-sub" id="tp-sub"></div><div id="tp-body"></div></div>';
  $('tp-period').onchange = function () { S.period = this.value; $('tp-custom').style.display = S.period === 'custom' ? 'inline' : 'none'; if (S.period !== 'custom') load(); };
  $('tp-from').onchange = function () { S.from = this.value; }; $('tp-to').onchange = function () { S.to = this.value; };
  $('tp-apply').onclick = load;
  $('tp-xls').onclick = function () { var r = range(); if (r.from && r.to) location.href = '/api/cc/team-report/download?from=' + r.from + '&to=' + r.to; };
  $('tp-seg').onclick = function (e) { var b = e.target.closest('button[data-v]'); if (!b) return; S.view = b.dataset.v; render(); };
  t.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active'); p.classList.add('active'); load();
  };
})();
