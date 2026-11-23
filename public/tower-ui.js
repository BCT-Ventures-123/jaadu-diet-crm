/* Admin "Control tower": the first screen. Is the chain healthy (orders to delivery) and what needs action now.
   Data: /api/cc/control-tower (rules in lib/controlTower.js). Uses helpers from admin.html ($, esc). */
(function () {
  var TZ = 'Asia/Kolkata';
  var tabsEl = $('tabs'), anchor = $('p-log');
  var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = 'tower'; t.textContent = 'Control tower';
  tabsEl.insertBefore(t, tabsEl.firstChild);
  var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-tower'; anchor.parentNode.appendChild(p);

  var css = '.ct{padding:6px 0 28px;color:var(--ds-text)}.ct-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.ct-title{font-size:1.25rem;font-weight:800;margin-right:auto}' +
    '.ct-btn{background:var(--ds-surface);color:var(--ds-text);border:1px solid var(--ds-border-strong);border-radius:8px;padding:9px 14px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit}' +
    '.ct-banner{display:flex;align-items:center;gap:12px;border-radius:10px;padding:14px 16px;margin-bottom:14px;font-weight:800;font-size:1.125rem}.ct-banner small{display:block;font-weight:500;font-size:0.8125rem;margin-top:2px}' +
    '.ct-banner.ok{background:var(--ds-brand-tint);color:var(--ds-brand-strong)}.ct-banner.bad{background:var(--ds-danger-tint);color:var(--ds-danger)}' +
    '.ct h3{font-size:1rem;font-weight:800;margin:22px 0 4px}.ct-sub{font-size:0.75rem;color:var(--ds-muted);margin-bottom:8px;line-height:1.5}' +
    '.ct-chain{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:8px}' +
    '.ct-st{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:12px;position:relative;min-height:112px}.ct-st .l{font-size:0.75rem;font-weight:700;color:var(--ds-muted)}' +
    '.ct-st .v{font-size:1.625rem;font-weight:800;line-height:1.15;margin:4px 0;font-variant-numeric:tabular-nums}.ct-st .pc{font-size:0.9375rem;font-weight:800}.ct-st .c{font-size:0.75rem;color:var(--ds-muted);line-height:1.4;margin-top:4px}' +
    '.ct-st.ok{border-color:#b9d9c5}.ct-st.ok .pc{color:var(--ds-brand)}.ct-st.warn{border-color:#ecd68a}.ct-st.warn .pc{color:var(--ds-warn-ink)}.ct-st.bad{border-color:#e8b4b4;background:var(--ds-danger-tint)}.ct-st.bad .pc{color:var(--ds-danger)}' +
    '.ct-st.nodata{border-style:dashed;background:transparent}.ct-st.nodata .v{color:var(--ds-muted)}.ct-tg{font-size:0.6875rem;color:var(--ds-muted);font-weight:600}' +
    '.ct-act{list-style:none;margin:6px 0 0;padding:0}.ct-act li{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:8px;margin-bottom:6px;font-size:0.875rem;line-height:1.45;background:var(--ds-surface);border:1px solid var(--ds-border)}' +
    '.ct-act li.bad{background:var(--ds-danger-tint);border-color:#e8b4b4}.ct-act li.warn{background:var(--ds-warn-tint);border-color:#ecd68a}.ct-act li span{flex:1}.ct-act li button{flex:none}' +
    '.ct-dot{width:10px;height:10px;border-radius:50%;flex:none}.ct-dot.bad{background:var(--ds-danger)}.ct-dot.warn{background:var(--ds-warn-ink)}' +
    '.ct-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.ct-card{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:12px 14px}' +
    '.ct-card .n{font-weight:800;margin-bottom:6px}.ct-card .r{display:flex;justify-content:space-between;font-size:0.875rem;padding:3px 0;color:var(--ds-muted)}.ct-card .r b{color:var(--ds-text);font-variant-numeric:tabular-nums}' +
    '.ct-card.ok{border-color:#b9d9c5}.ct-card.warn{border-color:#ecd68a}.ct-card.bad{border-color:#e8b4b4}' +
    '.ct-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.ct-tile{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:10px 12px}.ct-tile .l{font-size:0.75rem;font-weight:700;color:var(--ds-muted)}.ct-tile .v{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums}.ct-tile.bad .v{color:var(--ds-danger)}.ct-tile.warn .v{color:var(--ds-warn-ink)}' +
    '.ct-trend{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:12px}.ct-leg{display:flex;gap:16px;flex-wrap:wrap;font-size:0.75rem;color:var(--ds-muted);margin-top:6px}.ct-leg i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:5px;border-radius:2px}' +
    '.ct-err{background:var(--ds-danger-tint);color:var(--ds-danger);border-radius:8px;padding:10px 12px}.ct-load{padding:30px;text-align:center;color:var(--ds-muted)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function num(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }
  function pc(v) { return v == null ? '—' : v + '%'; }
  function nice(iso) { return new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' }); }
  function openTab(key) { var tb = document.querySelector('.tab[data-p="' + key + '"]'); if (tb) tb.click(); }

  function trendSvg(rows) {
    var W = 720, H = 190, L = 34, R = 10, T = 10, B = 24, n = rows.length;
    if (n < 2) return '<div class="ct-sub">Not enough days yet.</div>';
    var vals = []; rows.forEach(function (r) { [r.called_pct, r.reached_pct, r.confirmed_pct].forEach(function (v) { if (v != null) vals.push(v); }); });
    var lo = Math.max(0, Math.floor((Math.min.apply(null, vals.concat([90])) - 5) / 10) * 10), hi = 100;
    function x(i) { return L + (W - L - R) * i / (n - 1); } function y(v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Called, reached and confirmed percentage by day">';
    for (var g = lo; g <= hi; g += 10) s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--ds-border)" stroke-width="1"/><text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" font-size="11" text-anchor="end" fill="var(--ds-muted)">' + g + '</text>';
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(95) + '" y2="' + y(95) + '" stroke="var(--ds-brand)" stroke-width="1.5" stroke-dasharray="5 4"/>';
    function line(key, color) {
      var d = '', pen = false;
      rows.forEach(function (r, i) { var v = r[key]; if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; pen = true; });
      s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      var last = null; rows.forEach(function (r, i) { if (r[key] != null) last = i; });
      if (last != null) s += '<circle cx="' + x(last) + '" cy="' + y(rows[last][key]) + '" r="3.5" fill="' + color + '"/>';
    }
    line('called_pct', '#2b6cb0'); line('reached_pct', '#b7791f'); line('confirmed_pct', '#1f7a46');
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) { s += '<text x="' + x(i) + '" y="' + (H - 6) + '" font-size="11" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '" fill="var(--ds-muted)">' + esc(nice(rows[i].day)) + '</text>'; });
    return s + '</svg>';
  }

  function render(d) {
    var h = '';
    var bad = d.actions.filter(function (a) { return a.level === 'bad'; }).length;
    h += '<div class="ct-banner ' + (d.healthy ? 'ok' : 'bad') + '"><div>' + (d.healthy ? 'The chain looks healthy' : (bad + ' thing' + (bad === 1 ? '' : 's') + ' need action now')) +
      '<small>Last ' + d.window_days + ' days by order date · updated ' + new Date(d.generated_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) + ' India time</small></div></div>';
    h += '<h3>The chain, from order to delivery</h3><div class="ct-sub">Each box is a count and a share of the step before it. Pickup and delivery switch on when the courier history is connected.</div><div class="ct-chain">' +
      d.stages.map(function (s) {
        return '<div class="ct-st ' + (s.nodata ? 'nodata' : (s.tone || '')) + '"><div class="l">' + esc(s.label) + '</div><div class="v">' + num(s.count) + '</div>' + (s.pct != null ? '<div class="pc">' + pc(s.pct) + '</div>' : '') +
          '<div class="c">' + esc(s.caption) + '</div>' + (s.target ? '<div class="ct-tg">target ' + esc(s.target) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
    h += '<h3>What needs action now</h3>' + (d.actions.length ? '<ul class="ct-act">' + d.actions.map(function (a) {
      return '<li class="' + a.level + '"><i class="ct-dot ' + a.level + '"></i><span>' + esc(a.text) + '</span><button class="ct-btn" data-go="' + esc(a.go) + '">Open</button></li>';
    }).join('') + '</ul>' + (d.actions_total > d.actions.length ? '<div class="ct-sub">Showing the top ' + d.actions.length + ' of ' + d.actions_total + '.</div>' : '') : '<div class="ct-sub">Nothing needs action right now.</div>');
    if (d.teams.length) h += '<h3>Teams and channels</h3><div class="ct-grid">' + d.teams.map(function (x) {
      return '<div class="ct-card ' + (x.tone || '') + '"><div class="n">' + esc(x.label) + '</div><div class="r"><span>Leads</span><b>' + num(x.leads) + '</b></div>' +
        (x.called_pct != null ? '<div class="r"><span>Called</span><b>' + pc(x.called_pct) + '</b></div>' : '') + '<div class="r"><span>Reached</span><b>' + pc(x.reached_pct) + '</b></div>' +
        '<div class="r"><span>Confirmed</span><b>' + pc(x.confirmed_pct) + '</b></div>' + (x.not_called != null ? '<div class="r"><span>Never called</span><b>' + num(x.not_called) + '</b></div>' : '') + '</div>';
    }).join('') + '</div>';
    if (d.ship) h += '<h3>Shipping now</h3><div class="ct-tiles">' + [['Ready to ship', d.ship.ready, ''], ['Past ship-by time', d.ship.overdue, d.ship.overdue ? 'bad' : ''], ['Must ship today', d.ship.due_today, d.ship.due_today ? 'warn' : ''], ['Held back', d.ship.blocked, d.ship.blocked ? 'warn' : ''], ['Wrong ships', d.ship.wrong, d.ship.wrong ? 'bad' : '']].map(function (x) {
      return '<div class="ct-tile ' + x[2] + '"><div class="l">' + x[0] + '</div><div class="v">' + num(x[1]) + '</div></div>'; }).join('') + '</div>';
    else if (d.ship_note) h += '<h3>Shipping now</h3><div class="ct-sub">' + esc(d.ship_note) + '</div>';
    h += '<h3>Last 14 days</h3><div class="ct-trend">' + trendSvg(d.trend) + '<div class="ct-leg"><span><i style="background:#2b6cb0"></i>Called</span><span><i style="background:#b7791f"></i>Reached</span><span><i style="background:#1f7a46"></i>Confirmed</span><span><i style="background:var(--ds-brand)"></i>95% target (dashed)</span></div></div>';
    $('ct-body').innerHTML = h;
    // The latest manager brief (only reads the last one; the Agent tab writes new ones).
    fetch('/api/cc/ops-brief?peek=1').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.brief) return; var b = j.brief, first = b.items && b.items[0];
      var box = '<div class="ct-card" style="margin-bottom:14px"><div class="n">Manager brief <span class="ct-tg">' + (b.source === 'ai' ? 'AI' : 'plain') + ' · ' + new Date(b.created_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) + '</span></div>' +
        '<div style="font-size:0.9375rem;line-height:1.5">' + esc(b.headline) + (first ? ' <b>' + esc(first.who) + ':</b> ' + esc(first.what) : '') + '</div><div style="margin-top:8px"><button class="ct-btn" data-go="agent">Open the brief</button></div></div>';
      var ban = $('ct-body').querySelector('.ct-banner'); if (ban) ban.insertAdjacentHTML('afterend', box);
    }).catch(function () {});
  }
  function load() {
    $('ct-body').innerHTML = '<div class="ct-load">Loading…</div>';
    fetch('/api/cc/control-tower').then(function (res) {
      if (res.status === 401) { location.href = '/login.html?next=/admin.html'; throw new Error('login'); }
      return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not load the control tower'); return j; });
    }).then(render).catch(function (e) { if (e.message !== 'login') $('ct-body').innerHTML = '<div class="ct-err">' + esc(e.message) + '</div>'; });
  }
  p.innerHTML = '<div class="ct"><div class="ct-top"><div class="ct-title">Control tower</div><button class="ct-btn" id="ct-refresh">Refresh</button></div><div id="ct-body"></div></div>';
  $('ct-refresh').onclick = load;
  p.onclick = function (e) { var b = e.target.closest('button[data-go]'); if (b) openTab(b.dataset.go); };
  t.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active'); p.classList.add('active'); load();
  };
  setTimeout(function () { t.click(); }, 0);
})();
