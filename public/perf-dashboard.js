/* Performance Dashboard — two-section calling metrics.
   Section 1: Calling Activity (calls MADE in period — matches Calls Report / CSV)
   Section 2: Order Funnel (orders PLACED in period — cohort tracking)
   Admin mode adds: Channel breakdown (Aman / CC / IVR / WhatsApp / Total)

   PerfDash.init(el, { team: 'inhouse'|'cc'|'all', target: 95 }) */
(function () {
  var TZ = 'Asia/Kolkata';
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }

  var css = `
.pd{margin:0 24px 2px;background:linear-gradient(180deg,#0c1322 0%,#0d1425 100%);border:1px solid #1a2744;border-radius:14px;padding:14px 16px 12px;font-family:inherit;color:#e8edf5}
.pd *{box-sizing:border-box}
.pd-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.pd-title{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#4a6080;flex:1}
.pd-pills{display:flex;gap:4px}
.pd-pill{background:#0a1020;border:1px solid #1a2744;color:#7a8ba8;padding:5px 12px;border-radius:8px;font-size:.7rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s}
.pd-pill:hover{border-color:#3b5998;color:#c0cee0}
.pd-pill.on{background:#1a2d50;border-color:#3b6cb8;color:#7cb3f4}
.pd-sec{font-size:.6rem;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#3a5070;margin:10px 0 6px;padding-left:2px}
.pd-sec:first-of-type{margin-top:0}
.pd-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:900px){.pd-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){.pd-grid{grid-template-columns:1fr 1fr}.pd{margin:0 12px 2px;padding:10px 12px 8px}}
.pd-card{background:#0a1020;border:1px solid #162040;border-radius:10px;padding:10px 12px;position:relative;overflow:hidden;transition:border-color .2s}
.pd-card:hover{border-color:#2a4070}
.pd-val{font-size:1.5rem;font-weight:900;letter-spacing:-.5px;line-height:1}
.pd-pct{font-size:.72rem;font-weight:800;margin-left:4px}
.pd-label{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#4a6080;margin-top:5px}
.pd-bar{height:4px;background:#162040;border-radius:3px;margin-top:6px;overflow:hidden}
.pd-bar i{display:block;height:100%;border-radius:3px;transition:width .5s ease}
.pd-sub{font-size:.58rem;color:#4a6080;margin-top:4px;font-weight:600}
.c-green .pd-val,.c-green .pd-pct{color:#34d399}
.c-green .pd-bar i{background:linear-gradient(90deg,#10b981,#34d399)}
.c-green{border-color:#0f3d2e}
.c-yellow .pd-val,.c-yellow .pd-pct{color:#fbbf24}
.c-yellow .pd-bar i{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
.c-yellow{border-color:#3d3010}
.c-red .pd-val,.c-red .pd-pct{color:#f87171}
.c-red .pd-bar i{background:linear-gradient(90deg,#ef4444,#f87171)}
.c-red{border-color:#3d1010}
.c-blue .pd-val,.c-blue .pd-pct{color:#60a5fa}
.c-blue .pd-bar i{background:linear-gradient(90deg,#3b82f6,#60a5fa)}
.c-blue{border-color:#1a2d50}
.c-purple .pd-val,.c-purple .pd-pct{color:#a78bfa}
.c-purple .pd-bar i{background:linear-gradient(90deg,#7c3aed,#a78bfa)}
.c-purple{border-color:#2a1a50}
.c-cyan .pd-val,.c-cyan .pd-pct{color:#22d3ee}
.c-cyan .pd-bar i{background:linear-gradient(90deg,#06b6d4,#22d3ee)}
.c-cyan{border-color:#0a2a30}
.c-orange .pd-val,.c-orange .pd-pct{color:#fb923c}
.c-orange .pd-bar i{background:linear-gradient(90deg,#f97316,#fb923c)}
.c-orange{border-color:#3d2010}
.pd-target{position:absolute;top:8px;right:10px;font-size:.55rem;font-weight:700;padding:2px 6px;border-radius:4px}
.pd-target.hit{background:rgba(16,185,129,.15);color:#34d399}
.pd-target.miss{background:rgba(239,68,68,.12);color:#f87171}
.pd-loading{text-align:center;padding:20px;color:#4a6080;font-size:.78rem}
.pd-ch{margin-top:10px;border:1px solid #162040;border-radius:10px;overflow:hidden;font-size:.74rem}
.pd-ch table{width:100%;border-collapse:collapse}
.pd-ch th{background:#0a1020;color:#4a6080;font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:8px 10px;text-align:left}
.pd-ch td{padding:7px 10px;border-top:1px solid #111a30;color:#c0cee0}
.pd-ch tr:hover td{background:#0d1530}
.pd-ch .tot td{border-top:2px solid #1a2744;font-weight:800;color:#e8edf5}
.pd-ch .v-green{color:#34d399}.pd-ch .v-red{color:#f87171}.pd-ch .v-cyan{color:#22d3ee}.pd-ch .v-purple{color:#a78bfa}
`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function grade(pct, target) {
    if (pct >= target) return 'green';
    if (pct >= target - 15) return 'yellow';
    return 'red';
  }
  function rnd(n, d) { return d > 0 ? Math.round(n / d * 1000) / 10 : 0; }

  function card(label, value, pct, color, sub, targetPct) {
    var cls = 'c-' + color;
    var tgt = '';
    if (targetPct !== undefined) {
      tgt = '<span class="pd-target ' + (pct >= targetPct ? 'hit' : 'miss') + '">' +
        (pct >= targetPct ? '✓' : '↓') + ' ' + targetPct + '%</span>';
    }
    return '<div class="pd-card ' + cls + '">' + tgt +
      '<div><span class="pd-val">' + value + '</span>' + (pct !== null ? '<span class="pd-pct">' + pct + '%</span>' : '') + '</div>' +
      '<div class="pd-label">' + label + '</div>' +
      (pct !== null ? '<div class="pd-bar"><i style="width:' + Math.min(pct, 100) + '%"></i></div>' : '') +
      (sub ? '<div class="pd-sub">' + sub + '</div>' : '') +
      '</div>';
  }

  function renderActivity(ch, teamView) {
    var calls, spoke, confirmed, cancelled, noAnswer, addrFix;
    if (teamView === 'inhouse') {
      calls = ch.aman.calls; spoke = ch.aman.connected; confirmed = ch.aman.confirmed;
      cancelled = ch.aman.cancelled; noAnswer = ch.aman.dnp; addrFix = ch.aman.address_fix;
    } else if (teamView === 'cc') {
      calls = ch.cc.calls; spoke = ch.cc.connected; confirmed = ch.cc.confirmed;
      cancelled = ch.cc.cancelled; noAnswer = ch.cc.dnp; addrFix = ch.cc.address_fix;
    } else {
      calls = ch.aman.calls + ch.cc.calls + (ch.admin ? ch.admin.calls : 0);
      spoke = ch.aman.connected + ch.cc.connected + (ch.admin ? ch.admin.connected : 0);
      confirmed = ch.total.confirmed;
      cancelled = ch.total.cancelled;
      noAnswer = ch.aman.dnp + ch.cc.dnp + (ch.admin ? ch.admin.dnp : 0);
      addrFix = ch.aman.address_fix + ch.cc.address_fix + (ch.admin ? ch.admin.address_fix : 0);
    }
    var spokePct = rnd(spoke, calls);
    var cfmPct = rnd(confirmed, spoke);
    var h = '';
    h += card('Calls Made', calls, null, 'blue', null);
    h += card('Spoke / Connected', spoke, spokePct, grade(spokePct, 50), noAnswer + ' no answer');
    h += card('Confirmed', confirmed, cfmPct, 'green', rnd(confirmed, calls) + '% of calls');
    h += card('Cancelled', cancelled, rnd(cancelled, spoke), cancelled > spoke * 0.3 ? 'red' : 'cyan', addrFix + ' address fixed');
    return h;
  }

  function renderFunnel(f, p, target) {
    var total = f.total_orders || 0;
    var attempted = f.attempted || 0;
    var connected = f.connected || 0;
    var confirmed = f.confirmed || 0;
    var cancelled = f.cancelled || 0;
    var nc = f.not_connected || 0;
    var nc2 = f.nc_2nd || 0;
    var nc3 = f.nc_3rd || 0;
    var pending = f.pending || 0;
    var notCalled = total - attempted;

    var attPct = rnd(attempted, total);
    var conPct = rnd(connected, attempted);
    var ncPct = rnd(nc, attempted);
    var nc2Pct = rnd(nc2, nc);
    var nc3Pct = rnd(nc3, nc);

    var h = '';
    h += card('Total COD Orders', total, 100, 'blue', pending + ' pending · ' + notCalled + ' not called');
    h += card('Attempted', attempted, attPct, grade(attPct, target), notCalled + ' not called', target);
    h += card('Connected', connected, conPct, grade(conPct, target), (f.connected_on_1st || 0) + ' (1st) · ' + (f.connected_on_2nd || 0) + ' (2nd) · ' + (f.connected_on_3rd_plus || 0) + ' (3rd+)');
    h += card('Not Connected', nc, ncPct, ncPct > 20 ? 'red' : ncPct > 10 ? 'yellow' : 'purple', (p.nc_1 || 0) + ' (1st) · ' + (p.nc_2 || 0) + ' (2nd) · ' + (p.nc_3_plus || 0) + ' (3+)');
    return h;
  }

  function renderChannelTable(ch) {
    function row(name, cls, confirmed, cancelled, extra) {
      return '<tr><td class="' + cls + '">' + name + '</td><td><b class="v-green">' + confirmed + '</b></td><td class="v-red">' + cancelled + '</td><td>' + (confirmed + cancelled) + '</td>' + (extra || '') + '</tr>';
    }
    var h = '<div class="pd-ch"><table><thead><tr><th>Channel</th><th>Confirmed</th><th>Cancelled</th><th>Total Decided</th><th>Calls</th><th>Spoke</th></tr></thead><tbody>';
    h += '<tr><td>Aman (calls)</td><td><b class="v-green">' + ch.aman.confirmed + '</b></td><td class="v-red">' + ch.aman.cancelled + '</td><td>' + (ch.aman.confirmed + ch.aman.cancelled) + '</td><td>' + ch.aman.calls + '</td><td>' + ch.aman.connected + '</td></tr>';
    h += '<tr><td>Call Centre (calls)</td><td><b class="v-green">' + ch.cc.confirmed + '</b></td><td class="v-red">' + ch.cc.cancelled + '</td><td>' + (ch.cc.confirmed + ch.cc.cancelled) + '</td><td>' + ch.cc.calls + '</td><td>' + ch.cc.connected + '</td></tr>';
    h += '<tr><td>IVR</td><td><b class="v-cyan">' + ch.ivr.confirmed + '</b></td><td class="v-red">' + ch.ivr.cancelled + '</td><td>' + (ch.ivr.confirmed + ch.ivr.cancelled) + '</td><td colspan="2">' + ch.ivr.results + ' results · ' + ch.ivr.no_answer + ' no answer</td></tr>';
    h += '<tr><td>WhatsApp</td><td><b class="v-purple">' + ch.whatsapp.confirmed + '</b></td><td class="v-red">' + ch.whatsapp.cancelled + '</td><td>' + (ch.whatsapp.confirmed + ch.whatsapp.cancelled) + '</td><td colspan="2">' + ch.whatsapp.replies + ' replies</td></tr>';
    var oc = (ch.sheet ? ch.sheet.confirmed : 0) + (ch.other ? ch.other.confirmed : 0);
    var ox = (ch.sheet ? ch.sheet.cancelled : 0) + (ch.other ? ch.other.cancelled : 0);
    if (oc || ox) h += '<tr><td>Other (sheet/auto)</td><td><b>' + oc + '</b></td><td class="v-red">' + ox + '</td><td>' + (oc + ox) + '</td><td colspan="2">—</td></tr>';
    h += '<tr class="tot"><td>TOTAL</td><td><b class="v-green">' + ch.total.confirmed + '</b></td><td class="v-red">' + ch.total.cancelled + '</td><td>' + (ch.total.confirmed + ch.total.cancelled) + '</td><td colspan="2"></td></tr>';
    h += '</tbody></table></div>';
    return h;
  }

  function render(el, funnelData, channelsData, target, teamView) {
    var body = el.querySelector('.pd-body');
    if (!channelsData || !channelsData.channels) { body.innerHTML = '<div class="pd-loading">No data</div>'; return; }
    var ch = channelsData.channels;
    var h = '';

    h += '<div class="pd-sec">Calling Activity — calls made in this period</div>';
    h += '<div class="pd-grid">' + renderActivity(ch, teamView) + '</div>';

    if (funnelData && funnelData.funnel) {
      var f = funnelData.funnel;
      var p = funnelData.pipeline || {};
      h += '<div class="pd-sec" style="margin-top:12px">Order Funnel — orders placed in this period, where are they now</div>';
      h += '<div class="pd-grid">' + renderFunnel(f, p, target) + '</div>';
    }

    if (teamView === 'all') {
      h += '<div class="pd-sec" style="margin-top:12px">Confirmation by Channel</div>';
      h += renderChannelTable(ch);
    }

    body.innerHTML = h;
  }

  function init(el, opt) {
    opt = opt || {};
    var team = opt.team || 'all';
    var target = opt.target || 95;
    var period = 'today';
    var channelsView = team === 'inhouse' ? 'aman' : team === 'cc' ? 'cc' : 'all';

    el.innerHTML =
      '<div class="pd">' +
        '<div class="pd-head">' +
          '<div class="pd-title">Performance Dashboard</div>' +
          '<div class="pd-pills">' +
            '<button class="pd-pill on" data-p="today">Today</button>' +
            '<button class="pd-pill" data-p="last3">3 Days</button>' +
            '<button class="pd-pill" data-p="last7">7 Days</button>' +
            '<button class="pd-pill" data-p="last30">30 Days</button>' +
          '</div>' +
        '</div>' +
        '<div class="pd-body"><div class="pd-loading">Loading...</div></div>' +
      '</div>';

    var pills = el.querySelectorAll('.pd-pill');
    pills.forEach(function (btn) {
      btn.addEventListener('click', function () {
        pills.forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        period = btn.dataset.p;
        load();
      });
    });

    function getRange() {
      var t = today();
      if (period === 'today') return { from: t, to: t };
      if (period === 'last3') return { from: addDays(t, -2), to: t };
      if (period === 'last7') return { from: addDays(t, -6), to: t };
      return { from: addDays(t, -29), to: t };
    }

    function load() {
      var r = getRange();
      el.querySelector('.pd-body').innerHTML = '<div class="pd-loading">Loading...</div>';
      var funnelUrl = '/api/cc/funnel?from=' + r.from + '&to=' + r.to + '&team=' + encodeURIComponent(team);
      var channelsUrl = '/api/cc/channels?from=' + r.from + '&to=' + r.to + '&view=' + encodeURIComponent(channelsView);

      Promise.all([
        fetch(funnelUrl).then(function (res) {
          if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
          return res.json();
        }),
        fetch(channelsUrl).then(function (res) { return res.json(); })
      ]).then(function (results) {
        render(el, results[0], results[1], target, channelsView);
      }).catch(function (e) {
        if (e.message !== 'login') el.querySelector('.pd-body').innerHTML = '<div class="pd-loading">Error: ' + e.message + '</div>';
      });
    }

    load();
    return { refresh: load };
  }

  window.PerfDash = { init: init };
})();
