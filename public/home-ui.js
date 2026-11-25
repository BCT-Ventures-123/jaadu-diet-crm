/* Admin Home: one screen with five views (Overall, Aman, Call centre, IVR, WhatsApp), the same few numbers in each, one date filter.
   Data: /api/cc/team-report (rules in lib/teamReport.js), /api/cc/ivr-report (lib/ivrReport.js) and /api/cc/ivr-plan (today's live IVR).
   Every older report stays available under "More reports". Uses helpers from admin.html ($, esc). */
(function () {
  var TZ = 'Asia/Kolkata';
  var tabsEl = $('tabs'), anchor = $('p-log');
  var tab = document.createElement('div'); tab.className = 'tab'; tab.dataset.p = 'home'; tab.textContent = 'Home';
  tabsEl.insertBefore(tab, tabsEl.firstChild);
  var pane = document.createElement('div'); pane.className = 'pane'; pane.id = 'p-home'; anchor.parentNode.appendChild(pane);

  var css = '.hm{padding:6px 0 28px;color:var(--ds-text)}.hm-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.hm-title{font-size:1.25rem;font-weight:800;margin-right:auto}' +
    '.hm-btn{background:var(--ds-surface);color:var(--ds-text);border:1px solid var(--ds-border-strong);border-radius:8px;padding:8px 12px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit}.hm-btn.on{background:var(--ds-brand);border-color:var(--ds-brand);color:#fff}' +
    '.hm-date{padding:7px 8px;border:1px solid var(--ds-border-strong);border-radius:8px;background:var(--ds-surface);color:var(--ds-text);font-family:inherit;font-size:0.8125rem}' +
    '.hm-views{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px}.hm-views .hm-btn{padding:10px 16px;font-size:0.875rem}' +
    '.hm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}' +
    '.hm-k{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:10px;padding:12px 14px}.hm-k .l{font-size:0.75rem;font-weight:700;color:var(--ds-muted)}' +
    '.hm-k .v{font-size:1.625rem;font-weight:800;margin:2px 0;font-variant-numeric:tabular-nums}.hm-k .c{font-size:0.75rem;color:var(--ds-muted);line-height:1.35}' +
    '.hm-k.ok{border-color:#b9d9c5;background:var(--ds-brand-tint)}.hm-k.warn{border-color:#ecd68a;background:var(--ds-warn-tint)}.hm-k.bad{border-color:#e8b4b4;background:var(--ds-danger-tint)}' +
    '.hm h3{font-size:1rem;font-weight:800;margin:20px 0 6px}.hm-sub{font-size:0.75rem;color:var(--ds-muted);line-height:1.5;margin-bottom:8px}' +
    '.hm-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:6px;border:1px solid var(--ds-border);border-radius:8px;background:var(--ds-surface)}.hm-tbl{width:100%;min-width:520px;border-collapse:collapse;font-size:0.8125rem}.hm-tbl th,.hm-tbl td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--ds-border);font-variant-numeric:tabular-nums;vertical-align:middle}' +
    '.hm-tbl tr:last-child td{border-bottom:0}.hm-tbl th:first-child,.hm-tbl td:first-child{text-align:left}.hm-tbl th{font-size:0.6875rem;color:var(--ds-muted);font-weight:700;background:var(--ds-bg,transparent);white-space:nowrap}' +
    '.hm-tbl th.l,.hm-tbl td.l{text-align:left}.hm-tbl td:first-child{min-width:170px}.hm-tbl td:not(.m){white-space:nowrap}.hm-tbl td.m{text-align:left;color:var(--ds-muted);font-size:0.75rem;line-height:1.4;min-width:220px}.hm-wrap.s{max-width:620px}.hm-wrap.s .hm-tbl{min-width:0}.hm-tbl td.i1{padding-left:28px}.hm-tbl td.i2{padding-left:44px}' +
    '.hm-tbl tr.g td{background:var(--ds-brand-tint);color:var(--ds-muted);font-size:0.6875rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:6px 12px;text-align:left}.hm-tbl tr.tot td{font-weight:800}' +
    '.hm-bar{height:6px;border-radius:3px;background:var(--ds-border);min-width:70px;overflow:hidden}.hm-bar i{display:block;height:100%;background:var(--ds-brand);border-radius:3px}.hm-bar.warn i{background:#d69e2e}.hm-bar.bad i{background:#c0392b}' +
    '.hm-flag{padding:9px 12px;border-radius:8px;margin-bottom:6px;font-size:0.8125rem;line-height:1.45}.hm-flag.bad{background:var(--ds-danger-tint);color:var(--ds-danger)}.hm-flag.warn{background:var(--ds-warn-tint);color:var(--ds-warn-ink)}' +
    '.hm-live{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:10px;padding:12px 14px;font-size:0.875rem;line-height:1.6;margin-bottom:14px}' +
    '.hm-err{background:var(--ds-danger-tint);color:var(--ds-danger);border-radius:8px;padding:10px 12px}.hm-load{padding:30px;text-align:center;color:var(--ds-muted)}' +
    '#hm-menu{display:none;position:fixed;z-index:50;background:var(--ds-surface);border:1px solid var(--ds-border-strong);border-radius:10px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);min-width:200px;max-height:70vh;overflow:auto}' +
    '#hm-menu button{display:block;width:100%;text-align:left;background:none;border:0;padding:9px 12px;font:inherit;font-size:0.8125rem;font-weight:600;color:var(--ds-text);cursor:pointer;border-radius:6px}#hm-menu button:hover{background:var(--ds-brand-tint)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var S = { from: null, to: null, preset: 'today', view: 'overall', team: null, ivr: null, live: null, curve: null, recent: null, liveAt: null };
  var today = function () { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); };
  var addDays = function (d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function setPreset(k) {
    var t = today(); S.preset = k;
    if (k === 'today') { S.from = t; S.to = t; } else if (k === 'yesterday') { S.from = S.to = addDays(t, -1); }
    else if (k === '7d') { S.from = addDays(t, -6); S.to = t; } else if (k === 'month') { S.from = t.slice(0, 8) + '01'; S.to = t; }
  }
  setPreset('today');

  var num = function (n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); };
  var pc = function (v) { return v == null ? '—' : v + '%'; };
  function card(label, value, caption, tone) { return '<div class="hm-k ' + (tone || '') + '"><div class="l">' + esc(label) + '</div><div class="v">' + value + '</div><div class="c">' + esc(caption || '') + '</div></div>'; }
  // aligns: one letter per column, 'l' = left text, 'm' = left muted note, anything else = right number. Default: first column left, the rest right. A row {group:'Title'} is a section header; {cls:'tot', cells:[...]} styles a row.
  function table(head, rows, aligns) {
    var al = aligns || head.map(function (h, i) { return i === 0 ? 'l' : 'r'; }), n = head.length;
    return '<div class="hm-wrap' + (n <= 3 ? ' s' : '') + '"><table class="hm-tbl"><tr>' + head.map(function (h, i) { return '<th' + (al[i] === 'l' || al[i] === 'm' ? ' class="l"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr>' +
      (rows.length ? rows.map(function (r) {
        if (r && r.group) return '<tr class="g"><td colspan="' + n + '">' + esc(r.group) + '</td></tr>';
        var cells = r && r.cells ? r.cells : r, cls = r && r.cls ? ' class="' + r.cls + '"' : '';
        return '<tr' + cls + '>' + cells.map(function (c, i) { return '<td' + (al[i] === 'm' ? ' class="m"' : (al[i] === 'l' && i > 0 ? ' class="l"' : '')) + '>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') : '<tr><td colspan="' + n + '" style="text-align:center;color:var(--ds-muted)">No data for these dates</td></tr>') + '</table></div>';
  }
  function bar(p, tone) { return '<div class="hm-bar ' + (tone || '') + '"><i style="width:' + Math.max(0, Math.min(100, Number(p) || 0)) + '%"></i></div>'; }
  function kpiTone(list, key) { var k = (list || []).filter(function (x) { return x.key === key; })[0]; return k ? k.tone : ''; }
  function flagsHtml(list) { return list.length ? list.map(function (f) { return '<div class="hm-flag ' + f.level + '">' + esc(f.text) + '</div>'; }).join('') : '<div class="hm-sub">Nothing needs attention for these dates.</div>'; }
  // "n (p%)": the count and its share on the same base, so a table row reads left to right without mixing bases.
  function ratio(n, d) { return d ? Math.round(Number(n || 0) * 1000 / d) / 10 : 0; }
  function cell(n, p) { return num(n) + (p == null ? '' : ' <span style="color:var(--ds-muted);font-size:.85em">(' + p + '%)</span>'); }
  function dayLabel(d) { return esc(new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' })); }

  // The standard funnel, one layout for every view (lib/orderFunnel.js). Overall counts every channel; Aman, Call centre, IVR and WhatsApp count only their own attempts and the orders they decided.
  // Every percentage is a share of the orders in that view and those dates, so no row mixes bases.
  var CH = { overall: { who: 'any channel', att: 'by Aman, the call centre, the IVR or WhatsApp', short: 'all channels' }, aman: { who: 'Aman', att: 'called by Aman', short: 'Aman' }, cc: { who: 'the call centre', att: 'called by the call centre', short: 'the call centre' },
    ivr: { who: 'the IVR', att: 'a real IVR call was placed', short: 'the IVR' }, wa: { who: 'WhatsApp', att: 'a WhatsApp message went out or the customer replied', short: 'WhatsApp' } };
  function funnelBlock(F, scope, key, after, detailOnly) {
    key = key || 'overall';
    var n = F.orders, nc = F.nc_orders, ch = CH[key] || CH.overall, own = key !== 'overall';
    var othersHandled = Math.max(0, (F.orders || 0) - (F.attempted || 0) - (F.not_attempted || 0));
    var pad = function (px, txt) { return '<span style="padding-left:' + px + 'px;white-space:nowrap">' + txt + '</span>'; };
    var connNote = esc('the customer ' + (key === 'wa' ? 'replied' : key === 'ivr' ? 'pressed a key' : 'answered, pressed a key or replied') + ' (' + pc(F.connected_of_attempted_pct) + ' of the attempted)');
    var att = own ? [
      { group: 'Attempts: every order is counted under ONE channel' },
      { cls: 'tot', cells: ['Total orders', num(F.orders), '100%', bar(100), esc(scope)] },
      [pad(14, 'Attempted by ' + esc(ch.short)), num(F.attempted), pc(F.attempted_pct), bar(F.attempted_pct), esc('orders credited to ' + ch.short + ': it reached the customer first, or tried last when nobody answered')],
      [pad(28, 'Connected'), num(F.connected), pc(F.connected_pct), bar(F.connected_pct), connNote],
      [pad(28, 'Not connected'), num(F.not_connected), pc(F.not_connected_pct), bar(F.not_connected_pct, 'warn'), esc('tried by ' + ch.short + ', nobody answered yet')],
      [pad(14, 'Credited to other channels'), num(othersHandled), pc(ratio(othersHandled, F.orders)), bar(ratio(othersHandled, F.orders)), esc('Aman, the call centre, the IVR or WhatsApp: see their own views')],
      [pad(14, 'Not attempted by anyone'), num(F.not_attempted), pc(F.not_attempted_pct), bar(F.not_attempted_pct, F.not_attempted ? 'bad' : ''), esc(num(F.waiting_for_first_attempt) + ' still waiting, ' + num(F.closed_without_attempt) + ' closed by the sheet or system. The same in every view.')]    ] : [
      { group: 'Attempts' },
      { cls: 'tot', cells: ['Total orders', num(F.orders), '100%', bar(100), esc(scope)] },
      [pad(14, 'Attempted'), num(F.attempted), pc(F.attempted_pct), bar(F.attempted_pct), esc(ch.att)],
      [pad(28, 'Connected'), num(F.connected), pc(F.connected_pct), bar(F.connected_pct), connNote],
      [pad(28, 'Not connected'), num(F.not_connected), pc(F.not_connected_pct), bar(F.not_connected_pct, 'warn'), esc('attempted, nobody answered yet')],
      [pad(14, 'Not attempted'), num(F.not_attempted), pc(F.not_attempted_pct), bar(F.not_attempted_pct, F.not_attempted_pct > 10 ? 'bad' : 'warn'), esc(num(F.waiting_for_first_attempt) + ' still waiting for a first attempt, ' + num(F.closed_without_attempt) + ' closed with no attempt on any channel (sheet or system)')]];
    var rows = att      .concat([
      { group: own ? 'Result of these orders (only what ' + ch.short + ' decided)' : 'Result today' },
      ['Confirmed', num(F.confirmed), pc(F.confirmed_pct), bar(F.confirmed_pct), esc(own ? 'confirmed by ' + ch.short : 'any channel')],
      ['Cancelled', num(F.cancelled), pc(F.cancelled_pct), bar(F.cancelled_pct, 'bad'), esc(own ? 'cancelled by ' + ch.short : 'the customer said no, or auto-cancelled')]]
      .concat(own ? [['Decided by another channel', num(F.closed_by_others), pc(F.closed_by_others_pct), bar(F.closed_by_others_pct), esc('confirmed or cancelled by someone else, not in the numbers above')]] : [])
      .concat([['Still pending', num(F.pending), pc(F.pending_pct), bar(F.pending_pct, 'warn'), esc('not decided yet')]]));
    var h = detailOnly ? ladderHtml(F.ladder, key) : '<h3>Where the ' + num(n) + ' orders stand' + (own ? ' (' + esc(ch.short) + ')' : '') + '</h3><div class="hm-sub">Every percentage is a share of these ' + num(n) + ' orders. ' +
      (own ? 'The same ' + num(n) + ' orders as Overall, split by channel. Each order is counted once, so Aman, the call centre, the IVR and WhatsApp add up to Overall.' : 'Attempted counts every channel: a call by Aman or the call centre, a real IVR call, or WhatsApp.') + (key === 'wa' || key === 'overall' ? ' Until the WhatsApp bridge is live, messages sent are not stored, so WhatsApp counts only the customers who replied.' : '') + '</div>' +
      table(['', 'Orders', '% of orders', 'Share', 'What it means'], rows, ['l', 'r', 'r', 'r', 'm']) + (after || '') + ladderHtml(F.ladder, key);
    if (!own) {                                                                          // the channel views show the lead ladder above instead (a different base: leads tried by that channel)
      h += '<h3>First attempt</h3>' + table(['', 'Orders', '% of attempted'], [
        ['First attempt made', num(F.attempted), F.attempted ? '100%' : '—'],
        ['Answered on the first attempt', num(F.first_connected), pc(F.first_connected_pct)],
        ['Not answered on the first attempt', num(F.first_not_connected), pc(F.first_not_connected_pct)]]);
      h += '<h3>Orders nobody answered: 2nd and 3rd attempt</h3><div class="hm-sub">' + num(nc) + ' orders were attempted and nobody has answered. "Same day" means the same day as the first attempt.</div>' +
        table(['', 'Done the same day', 'Done on a later day', 'Not done yet'], [
          ['2nd attempt', cell(F.second_same_day, ratio(F.second_same_day, nc)), cell(F.second_later_day, ratio(F.second_later_day, nc)), cell(F.second_not_yet, ratio(F.second_not_yet, nc))],
          ['3rd attempt', cell(F.third_same_day, ratio(F.third_same_day, nc)), cell(F.third_later_day, ratio(F.third_later_day, nc)), cell(F.third_not_yet, ratio(F.third_not_yet, nc))]]);
    }
    if (!own) h += '<h3>Same-day shipping</h3><div class="hm-sub">An order confirmed before the 2 PM lock ships the same day (packing 2 to 4 PM, courier pickup at 4 PM). Only orders placed before 1 PM can make it. Percentages are a share of those orders.</div>' + table(['', 'Orders', '% of these orders'], [
      { cls: 'tot', cells: ['Orders placed before 1 PM', num(F.ship_pool), F.ship_pool ? '100%' : '—'] },
      ['Confirmed before the 2 PM lock (ships today)', num(F.same_day_confirmed), pc(F.same_day_confirmed_pct)],
      ['Confirmed later (ships another day)', num(F.pool_confirmed_late), pc(F.pool_confirmed_late_pct)],
      ['Not confirmed (pending or cancelled)', num(F.pool_not_confirmed), pc(F.pool_not_confirmed_pct)]]);
    return h;
  }  // Where the Overall numbers sit, two ways, each adding up exactly to the Overall table (lib/orderFunnel.js breakdown).
  function breakdownHtml(B, FUN) {
    if (!B) return '';
    var O = B.by_owner, T = B.total, R = B.reach, n = T.orders;
    var ownRow = function (label, b) { return [label, num(b.orders), cell(b.attempted, b.attempted_pct), cell(b.connected, b.connected_pct), cell(b.not_connected, b.not_connected_pct), cell(b.not_attempted, b.not_attempted_pct)]; };
    var rowsO = [ownRow('Aman', O.aman), ownRow('Call centre', O.cc)].concat(O.other.orders ? [ownRow('With neither', O.other)] : []).concat([{ cls: 'tot', cells: ownRow('Total (same as above)', T) }]);
    var h = '<h3>Where these orders sit: by team</h3><div class="hm-sub">Every order was given to one team, so these rows add up to the totals above. Attempted, connected and not connected count attempts on any channel (call, IVR, WhatsApp). The Aman and Call centre views show the same orders in detail.</div>' +
      table(['', 'Orders', 'Attempted', 'Connected', 'Not connected', 'Not attempted'], rowsO);
    var FU = FUN || {}, chs = [['Aman', FU.aman], ['Call centre', FU.cc], ['IVR', FU.ivr], ['WhatsApp', FU.wa]], OV = FU.overall;
    if (OV) {
      var sumC = 0, sumX = 0; chs.forEach(function (x) { if (x[1]) { sumC += x[1].confirmed; sumX += x[1].cancelled; } });
      var chRows = chs.filter(function (x) { return x[1]; }).map(function (x) { var v = x[1]; return [x[0], num(v.attempted), cell(v.connected, ratio(v.connected, OV.orders)), cell(v.not_connected, ratio(v.not_connected, OV.orders)), cell(v.confirmed, ratio(v.confirmed, OV.orders)), cell(v.cancelled, ratio(v.cancelled, OV.orders))]; });
      chRows.push(['Sheet or system', '—', '—', '—', cell(Math.max(0, OV.confirmed - sumC), ratio(Math.max(0, OV.confirmed - sumC), OV.orders)), cell(Math.max(0, OV.cancelled - sumX), ratio(Math.max(0, OV.cancelled - sumX), OV.orders))]);
      chRows.push(['Not attempted by anyone', num(OV.not_attempted), '—', '—', '—', '—']);
      chRows.push({ cls: 'tot', cells: ['Total (same as above)', num(OV.orders), cell(OV.connected, OV.connected_pct), cell(OV.not_connected, OV.not_connected_pct), cell(OV.confirmed, OV.confirmed_pct), cell(OV.cancelled, OV.cancelled_pct)] });
      h += '<h3>By channel: every order counted once</h3><div class="hm-sub">An order is credited to the channel that first reached the customer, or to the one that tried last when nobody answered. Confirmed and cancelled go to the channel that decided the order. So every column adds up to the Total row, and each channel\'s own view shows the same numbers in detail.</div>' +
        table(['', 'Orders credited', 'Connected', 'Not connected', 'Confirmed', 'Cancelled'], chRows);
    }    return h;
  }
  // The orders given to Aman or the call centre, whatever channel worked them (lib/orderFunnel.js breakdown.by_owner): this is the team's queue, including what is still waiting.
  function ownedHtml(B, key) {
    var b = B && B.by_owner && B.by_owner[key]; if (!b) return '';
    var who = key === 'aman' ? 'Aman' : 'the call centre';
    return '<h3>Orders given to ' + who + '</h3><div class="hm-sub">The orders in ' + who + '\'s queue, whichever channel worked them (call, IVR or WhatsApp). This is the queue, not ' + who + '\'s own calling.</div>' +
      table(['', 'Orders', 'Attempted', 'Connected', 'Not connected', 'Not attempted'], [[esc('Given to ' + who), num(b.orders), cell(b.attempted, b.attempted_pct), cell(b.connected, b.connected_pct), cell(b.not_connected, b.not_connected_pct), cell(b.not_attempted, b.not_attempted_pct)]]);
  }
  // LEADS BY ATTEMPT NUMBER: of the orders on these dates, how many had a 1st, 2nd, 3rd ... attempt on this channel and on which attempt the customer was reached. Counts orders, not calls.
  function ladderHtml(L, key) {
    if (!L || !L.tried) return '';
    var ch = (CH[key] || CH.overall).short, noun = key === 'wa' ? 'message' : 'attempt';
    var rows = L.rows.filter(function (x, i) { return x.leads > 0 || i < 3; }).map(function (x) {
      return [ordinal(x.attempt) + ' ' + noun, num(x.leads), pc(x.leads_pct), cell(x.connected_here, x.connected_here_pct), cell(x.connected_so_far, x.connected_so_far_pct), num(x.not_connected_after)];
    });
    return '<h3>Leads by attempt number (' + esc(ch) + ')</h3><div class="hm-sub">Of ' + num(L.orders) + ' orders, <b>' + num(L.tried) + '</b> (' + pc(L.tried_pct) + ') had at least one ' + noun + ' on ' + esc(ch) + ', and <b>' + num(L.connected) + '</b> of them (' + pc(L.connected_pct) + ') were reached. Every row counts leads, not calls: a lead appears in the 2nd row only if it had a 2nd ' + noun + '.' + (L.more_than_max ? ' ' + num(L.more_than_max) + ' leads had more than ' + L.max + '.' : '') + '</div>' +
      table(['', 'Leads tried', '% of all orders', 'Reached on this ' + noun, 'Reached so far', 'Not reached yet'], rows);
  }
  function ordinal(n) { return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'); }
  // THE 2 PM SCORECARD: fresh orders confirmed before the lock, and the old no-answer leads reached before it.
  function twoPmHtml(P) {
    if (!P || !P.today) return '';
    var f = P.today.fresh, o = P.today.old, live = P.today.live, d = P.today.day;
    var h = '<h3>2 PM scorecard for ' + dayLabel(d) + (live ? ' <span style="color:var(--ds-muted);font-weight:600;font-size:.8em">live, so far</span>' : '') + '</h3><div class="hm-sub">An order confirmed before 2 PM ships the same day. <b>Fresh orders</b> are those placed after yesterday\'s 2 PM and before 1 PM today: all of them should be attempted and confirmed before 2 PM. <b>Old no-answer leads</b> are older orders still open when the day began: reach as many as the callers\' time allows before 2 PM. Counts are orders, not calls.</div>';
    h += table(['', 'Orders', '% of group', 'Share', 'What it means'], [
      { group: 'Fresh orders (target: all confirmed before 2 PM)' },
      { cls: 'tot', cells: ['Fresh orders', num(f.pool), '100%', bar(100), esc('placed after yesterday 2 PM and before 1 PM today')] },
      ['Attempted by 2 PM', num(f.attempted_by_cut), pc(f.attempted_by_cut_pct), bar(f.attempted_by_cut_pct, f.not_attempted_by_cut ? 'warn' : ''), esc('any channel: call, IVR or WhatsApp')],
      ['Confirmed by 2 PM', num(f.confirmed_by_cut), pc(f.confirmed_by_cut_pct), bar(f.confirmed_by_cut_pct), esc('ships today')],
      ['Cancelled by 2 PM', num(f.cancelled_by_cut), pc(f.cancelled_by_cut_pct), bar(f.cancelled_by_cut_pct, 'bad'), esc('the customer said no')],
      ['Still open', num(f.open), pc(f.open_pct), bar(f.open_pct, f.open ? 'bad' : ''), esc(num(f.open_tried) + ' tried, nobody answered or decided; ' + num(f.open_not_tried) + ' not tried at all')],
      { group: 'Old no-answer leads (reach as many as possible)' },
      { cls: 'tot', cells: ['Old open leads', num(o.pool), '100%', bar(100), esc('older orders not confirmed or cancelled when the day began; ' + num(o.never_tried) + ' never tried by anyone')] },
      ['Reached before 2 PM', num(o.reached), pc(o.reached_pct), bar(o.reached_pct), esc('at least one attempt today before 2 PM')],
      ['Confirmed before 2 PM', num(o.confirmed_by_cut), pc(o.confirmed_by_cut_pct), bar(o.confirmed_by_cut_pct), esc('these also ship today')],
      ['Still open', num(o.open), pc(o.open_pct), bar(o.open_pct, 'warn'), esc('not confirmed before 2 PM')]], ['l', 'r', 'r', 'r', 'm']);
    var days = P.days || [];
    if (days.length) h += '<h3>Last 7 days</h3>' + table(['Day', 'Fresh orders', 'Attempted by 2 PM', 'Confirmed by 2 PM', 'Old open leads', 'Old reached by 2 PM', 'Old confirmed by 2 PM'],
      days.map(function (x) { return [dayLabel(x.day), num(x.fresh.pool), cell(x.fresh.attempted_by_cut, x.fresh.attempted_by_cut_pct), cell(x.fresh.confirmed_by_cut, x.fresh.confirmed_by_cut_pct), num(x.old.pool), cell(x.old.reached, x.old.reached_pct), cell(x.old.confirmed_by_cut, x.old.confirmed_by_cut_pct)]; }));
    return h;
  }  // WhatsApp per message: how many orders each message reached and what the customers did. Counts orders, not messages.
  function waReportHtml(W) {
    if (!W) return '';
    var h = '<h3>WhatsApp messages, one by one</h3><div class="hm-sub">Orders placed on these dates: <b>' + num(W.orders) + '</b>. Got at least one WhatsApp message: <b>' + num(W.orders_messaged) + '</b> (' + pc(W.orders_messaged_pct) + '). Confirmed with the WhatsApp button: <b>' + num(W.confirmed_by_whatsapp) + '</b>. Each row counts orders. The 2nd message goes 4 hours after the 1st, the 3rd 4 hours after the 2nd.</div>';
    if (!W.bridge_has_data) return h + '<div class="hm-flag warn">No WhatsApp messages are recorded for these dates yet. The WhatsApp bridge records every message sent; this table fills as soon as it is live.</div>';
    return h + table(['', 'Orders messaged', 'Delivered', 'Read', 'Confirm', 'Cancel', 'Change address', 'Replied', 'No response yet'],
      W.steps.map(function (s) { return [esc(s.label), num(s.sent), cell(s.delivered, ratio(s.delivered, s.sent)), cell(s.read, ratio(s.read, s.sent)), cell(s.confirm, ratio(s.confirm, s.sent)), cell(s.cancel, ratio(s.cancel, s.sent)), cell(s.change_address, ratio(s.change_address, s.sent)), cell(s.replied, ratio(s.replied, s.sent)), num(s.no_response)]; }));
  }  // ===== THE LEDGER PAGES (lib/ledger.js): every number below is added up from one list of orders, so the pages agree =====
  var CHN = [['aman', 'Aman'], ['cc', 'Call centre'], ['ivr', 'IVR'], ['wa', 'WhatsApp']];
  function asOf(L) { return new Date(L.as_of).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  // The checks line: green when every page adds up, red with the exact check that fails.
  function checksHtml(L) {
    if (!L) return '';
    var c = L.checks, bad = c.list.filter(function (x) { return !x.ok; });
    return '<div class="hm-flag ' + (c.ok ? 'ok' : 'bad') + '" style="' + (c.ok ? 'background:var(--ds-brand-tint);color:var(--ds-brand)' : '') + '"><b>' + (c.ok ? 'All ' + c.list.length + ' checks pass' : bad.length + ' of ' + c.list.length + ' checks FAIL') + '</b> · numbers read ' + esc(asOf(L)) + ' (India time), so orders placed in the last hour are not late yet.' +
      (c.ok ? ' Every page adds up from the same list of orders.' : '<br>' + bad.map(function (x) { return esc(x.name) + (x.detail ? ' (' + esc(x.detail) + ')' : ''); }).join('<br>')) +
      '<br><a href="/api/cc/orders-ledger.csv?from=' + S.from + '&to=' + S.to + '" style="font-weight:700">Order-wise sheet (CSV)</a>: one row per order · <a href="/api/cc/attempts-log.csv?from=' + S.from + '&to=' + S.to + '" style="font-weight:700">All attempts (CSV)</a>: every call, IVR call and WhatsApp message.</div>';
  }
  // Orders placed, prepaid and COD, then everything about the COD orders: attempted, connected, not connected, not attempted (with age), confirmed, cancelled, not confirmed.
  function codTable(L) {
    var T = L.summary.total, n = T.leads, w = T.wait_age, p = function (v) { return pc(ratio(v, n)); }, b = function (v, tone) { return bar(ratio(v, n), tone); };
    return '<h3>Where the ' + num(L.cod) + ' COD orders stand</h3><div class="hm-sub">Every percentage is a share of the ' + num(L.cod) + ' COD tea orders placed on these dates. Attempted means any channel tried: a call by Aman or the call centre, an IVR call, or WhatsApp. Prepaid orders need no confirmation and are left out below.</div>' + table(['', 'Orders', '% of COD', 'Share', 'What it means'], [
      { group: 'Orders placed' },
      { cls: 'tot', cells: ['All orders placed', num(L.orders_total), '', '', esc('prepaid and COD together')] },
      ['Prepaid', num(L.prepaid), '', '', esc('paid already, no confirmation call')],
      { cls: 'tot', cells: ['COD orders', num(L.cod), '100%', bar(100), esc('real COD tea orders: the base of everything below')] },
      { group: 'Attempts' },
      ['Attempted', num(T.attempted), p(T.attempted), b(T.attempted), esc('at least one attempt on any channel')],
      ['Connected', num(T.connected), p(T.connected), b(T.connected), esc('the customer answered, pressed a key or replied (' + pc(ratio(T.connected, T.attempted)) + ' of the attempted)')],
      ['Not connected', num(T.tried_not_reached), p(T.tried_not_reached), b(T.tried_not_reached, 'warn'), esc('tried, nobody answered yet')],
      ['Not attempted', num(T.not_attempted), p(T.not_attempted), b(T.not_attempted, T.not_attempted ? 'bad' : ''), esc('nobody on any channel has tried these')],
      ['<span style="padding-left:28px;white-space:nowrap">waiting under 1 hour</span>', num(w.lt1h), p(w.lt1h), b(w.lt1h), esc('new orders, not late yet')],
      ['<span style="padding-left:28px;white-space:nowrap">waiting 1 to 6 hours</span>', num(w.h1_6), p(w.h1_6), b(w.h1_6, 'warn'), esc('pending, nobody has tried')],
      ['<span style="padding-left:28px;white-space:nowrap">waiting 6 to 24 hours</span>', num(w.h6_24), p(w.h6_24), b(w.h6_24, 'bad'), esc('late')],
      ['<span style="padding-left:28px;white-space:nowrap">waiting over 24 hours</span>', num(w.gt24), p(w.gt24), b(w.gt24, 'bad'), esc('very late')],
      ['<span style="padding-left:28px;white-space:nowrap">closed with no attempt</span>', num(T.closed_without_attempt), p(T.closed_without_attempt), b(T.closed_without_attempt, 'warn'), esc('confirmed or cancelled by the sheet or system')],
      { group: 'Result' },
      ['Confirmed', num(T.confirmed), p(T.confirmed), b(T.confirmed), esc('any channel')],
      ['Cancelled', num(T.cancelled), p(T.cancelled), b(T.cancelled, 'bad'), esc('the customer said no, or auto-cancelled')],
      ['Not confirmed', num(T.not_confirmed), p(T.not_confirmed), b(T.not_confirmed, 'warn'), esc('pending, no answer or still being worked')]], ['l', 'r', 'r', 'r', 'm']);
  }
  // Rows: whose lead it is. Columns: who reached the customer. Every lead sits in exactly one column, so each row and the Total add up.
  function gridHtml(L) {
    var S2 = L.summary, rowOf = function (label, b, cls) {
      var cells = [label, num(b.leads)].concat(CHN.map(function (c) { return cell(b.reached[c[0]], ratio(b.reached[c[0]], b.leads)); })).concat([cell(b.tried_not_reached, ratio(b.tried_not_reached, b.leads)), cell(b.not_attempted, ratio(b.not_attempted, b.leads))]);
      return cls ? { cls: cls, cells: cells } : cells;
    };
    var rows = [rowOf('Aman\'s leads', S2.teams.aman), rowOf('Call centre\'s leads', S2.teams.cc)];
    if (S2.teams.other.leads) rows.push(rowOf('Given to neither', S2.teams.other));
    rows.push(rowOf('Total (same as above)', S2.total, 'tot'));
    var hold = function (label, b, cls) {
      var cells = [label].concat(CHN.map(function (c) { return num(b.tried_by[c[0]]); })).concat([num(b.wait_age.lt1h), num(b.wait_age.h1_6), num(b.wait_age.h6_24), num(b.wait_age.gt24), num(b.closed_without_attempt)]);
      return cls ? { cls: cls, cells: cells } : cells;
    };
    var rows2 = [hold('Aman\'s leads', S2.teams.aman), hold('Call centre\'s leads', S2.teams.cc), hold('Total', S2.total, 'tot')];
    return '<h3>Who reached the customer, lead by lead</h3><div class="hm-sub">Each row is the leads given to that team. Each lead is counted once, under the channel that first reached the customer. If Aman got no answer and WhatsApp then confirmed, it is WhatsApp\'s. Reached by + tried + not attempted = the team\'s leads, and the Total row is the table above.</div>' +
      table(['', 'Leads', 'Reached by Aman', 'Reached by Call centre', 'Reached by IVR', 'Reached by WhatsApp', 'Tried, nobody answered', 'Not attempted'], rows) +
      '<h3>The leads that are not reached yet: who holds them</h3><div class="hm-sub">Tried but nobody answered: shown under the channel that tried last. Not attempted: shown by how long the order has been waiting.</div>' +
      table(['', 'Aman tried last', 'Call centre tried last', 'IVR tried last', 'WhatsApp tried last', 'Waiting under 1 h', '1 to 6 h', '6 to 24 h', 'Over 24 h', 'Closed, no attempt'], rows2);
  }
  // Confirmation by order age: each day judged at the same age.
  function ageHtml(L) {
    var days = (L.age || []).slice(-14); if (!days.length) return '';
    var c = function (n, of, p) { return of ? cell(n, p) : '—'; };
    return '<h3>Confirmation by order age</h3><div class="hm-sub">Each day is judged at the same age, so a recent day is not unfairly compared with an old one. An order too young for a column is left out of it, not counted as a failure.</div>' +
      table(['Order date', 'Orders', 'Confirmed within 2 hours', 'Confirmed within 24 hours', 'Confirmed within 48 hours', 'Cancelled within 48 hours'], days.map(function (d) { return [dayLabel(d.day), num(d.orders), c(d.h2, d.h2_of, d.h2_pct), c(d.h24, d.h24_of, d.h24_pct), c(d.h48, d.h48_of, d.h48_pct), num(d.cancelled_h48)]; }));
  }
  // The CRM against Shopify, last 3 days.
  function shopifyHtml(Sh) {
    if (!Sh) return '';
    if (!Sh.configured) return '<h3>CRM against Shopify</h3><div class="hm-flag warn">' + esc(Sh.message || 'Shopify is not connected in the web service.') + '</div>';
    var rows = [['Orders in Shopify (last ' + Sh.window_days + ' days)', num(Sh.shopify_orders), ''], ['Found in the CRM', num(Sh.matched), '']].concat([
      ['In Shopify but missing in the CRM', Sh.missing_in_crm], ['Cancelled on Shopify, still open in the CRM', Sh.cancelled_on_shopify_not_in_crm], ['Cancelled in the CRM, not cancelled on Shopify', Sh.cancelled_in_crm_not_on_shopify], ['Confirmed in the CRM, no "confirmed" tag on Shopify', Sh.confirmed_not_tagged_on_shopify]].map(function (x) { return [x[0], num(x[1].n), x[1].n ? esc(x[1].orders.slice(0, 8).join(', ') + (x[1].n > 8 ? ' …' : '')) : '']; }));
    return '<h3>CRM against Shopify</h3><div class="hm-sub">Read-only check of the last ' + Sh.window_days + ' days, ' + (Sh.problems ? '<b>' + num(Sh.problems) + ' orders to fix</b>' : '<b>no differences</b>') + '. Checked ' + esc(new Date(Sh.checked_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })) + '.</div>' + table(['', 'Orders', 'Examples'], rows, ['l', 'r', 'm']);
  }
  // One team's page: only that team's leads. Each lead is credited to the channel that reached the customer, so a lead Aman could not reach and WhatsApp confirmed is WhatsApp's, not Aman's.
  function teamLedgerHtml(L, key) {
    if (!L) return '<div class="hm-sub">The order ledger is not ready on the server yet. Refresh in a minute.</div>';
    var B = L.summary.teams[key], who = key === 'aman' ? 'Aman' : 'the call centre', own = B.own[key], n = B.leads, p = function (v) { return pc(ratio(v, n)); }, b = function (v, tone) { return bar(ratio(v, n), tone); };
    var others = ['aman', 'cc', 'ivr', 'wa'].filter(function (k) { return k !== key; });
    var name = { aman: 'Aman', cc: 'the call centre', ivr: 'the IVR', wa: 'WhatsApp' };
    var rows = [
      { group: 'What happened to these leads (each lead counted once)' },
      { cls: 'tot', cells: ['Leads given to ' + who, num(n), '100%', bar(100), esc('this team\'s leads on these dates')] },
      ['Reached by ' + who, num(B.reached[key]), p(B.reached[key]), b(B.reached[key]), esc('the customer answered ' + who + ' (' + pc(ratio(B.reached[key], n)) + ' of the leads)')]]
      .concat(others.map(function (k) { return ['Reached by ' + name[k], num(B.reached[k]), p(B.reached[k]), b(B.reached[k]), esc('credited to ' + name[k] + ', not to ' + who)]; }))
      .concat([
        ['Tried, nobody answered', num(B.tried_not_reached), p(B.tried_not_reached), b(B.tried_not_reached, 'warn'), esc('held by ' + CHN.map(function (c) { return B.tried_by[c[0]] ? c[1] + ' ' + num(B.tried_by[c[0]]) : ''; }).filter(Boolean).join(', ') || 'nobody')],
        ['Not attempted by anyone', num(B.not_attempted), p(B.not_attempted), b(B.not_attempted, B.not_attempted ? 'bad' : ''), esc(num(B.wait_age.lt1h) + ' under 1 hour, ' + num(B.wait_age.h1_6) + ' 1 to 6 hours, ' + num(B.wait_age.h6_24) + ' 6 to 24 hours, ' + num(B.wait_age.gt24) + ' over 24 hours, ' + num(B.closed_without_attempt) + ' closed with no attempt')],
        { group: 'Result of these leads' },
        ['Confirmed', num(B.confirmed), p(B.confirmed), b(B.confirmed), esc(num(B.confirmed_by[key]) + ' by ' + who + ', ' + num(B.confirmed - B.confirmed_by[key]) + ' by the other channels')],
        ['Cancelled', num(B.cancelled), p(B.cancelled), b(B.cancelled, 'bad'), esc(num(B.cancelled_by[key]) + ' by ' + who + ', ' + num(B.cancelled - B.cancelled_by[key]) + ' by the other channels')],
        ['Not confirmed', num(B.not_confirmed), p(B.not_confirmed), b(B.not_confirmed, 'warn'), esc('pending or no answer')],
        { group: who.charAt(0).toUpperCase() + who.slice(1) + '\'s own work on these leads' },
        ['Leads ' + who + ' tried', num(own.tried), p(own.tried), b(own.tried), esc('at least one call by ' + who + '; other channels may have tried too')],
        ['Leads ' + who + ' reached', num(own.reached), p(own.reached), b(own.reached), esc(pc(ratio(own.reached, own.tried)) + ' of the leads ' + who + ' tried')],
        ['Confirmed by ' + who, num(own.confirmed), p(own.confirmed), b(own.confirmed), esc('the decision was made on ' + who + '\'s call')],
        ['Cancelled by ' + who, num(own.cancelled), p(own.cancelled), b(own.cancelled, 'bad'), esc('the decision was made on ' + who + '\'s call')]]);
    return '<h3>' + (key === 'aman' ? 'Aman' : 'Call centre') + ': ' + num(n) + ' leads</h3><div class="hm-sub">Only the leads given to ' + who + '. A lead that ' + who + ' could not reach and another channel confirmed counts for that channel. Add the Aman and Call centre pages and you get the Overall page.</div>' + table(['', 'Leads', '% of leads', 'Share', 'What it means'], rows, ['l', 'r', 'r', 'r', 'm']);
  }
  // The IVR or WhatsApp page: the leads that channel reached or last tried, and the decisions it made, split by whose lead it was.
  function channelLedgerHtml(L, key) {
    if (!L) return '<div class="hm-sub">The order ledger is not ready on the server yet. Refresh in a minute.</div>';
    var S2 = L.summary, T = S2.total, nm = key === 'ivr' ? 'the IVR' : 'WhatsApp', n = T.leads, A = S2.teams.aman, C = S2.teams.cc;
    var split = function (f) { return 'Aman\'s leads ' + num(f(A)) + ', call centre\'s ' + num(f(C)) + (S2.teams.other.leads ? ', neither ' + num(f(S2.teams.other)) : ''); };
    var row = function (label, f, note, tone) { return [label, num(f(T)), pc(ratio(f(T), n)), bar(ratio(f(T), n), tone), esc(note + ' (' + split(f) + ')')]; };
    return '<h3>' + (key === 'ivr' ? 'IVR' : 'WhatsApp') + ' on the ' + num(n) + ' COD orders</h3><div class="hm-sub">Each order is counted once. An order is ' + nm + '\'s only if ' + nm + ' reached the customer first, or tried last when nobody answered. Add Aman, Call centre, IVR and WhatsApp and you get the Overall page.</div>' + table(['', 'Orders', '% of COD', 'Share', 'Whose leads'], [
      row('Reached by ' + nm, function (b) { return b.reached[key]; }, 'the customer ' + (key === 'ivr' ? 'pressed a key' : 'replied')),
      row('Tried last, nobody answered', function (b) { return b.tried_by[key]; }, 'no key pressed or no reply yet', 'warn'),
      row('Confirmed by ' + nm, function (b) { return b.confirmed_by[key]; }, 'the confirm decision came from ' + nm),
      row('Cancelled by ' + nm, function (b) { return b.cancelled_by[key]; }, 'the cancel decision came from ' + nm, 'bad'),
      row('Orders ' + nm + ' tried at all', function (b) { return b.own[key].tried; }, 'at least one ' + (key === 'ivr' ? 'IVR call' : 'message or reply') + ', other channels may have tried too')], ['l', 'r', 'r', 'r', 'm']);
  }
  // Day by day from the ledger: every row is that day's orders, so the days add up to the total.
  function ledgerDays(rows, title) {
    if (!rows || !rows.length) return '';
    var tot = rows.reduce(function (a, d) { ['leads', 'attempted', 'connected', 'tried_not_reached', 'not_attempted', 'confirmed', 'cancelled', 'not_confirmed'].forEach(function (k) { a[k] = (a[k] || 0) + d[k]; }); return a; }, {});
    var line = function (label, d, cls) { var c = [label, cls ? '<b>' + num(d.leads) + '</b>' : num(d.leads), cell(d.attempted, ratio(d.attempted, d.leads)), cell(d.connected, ratio(d.connected, d.leads)), cell(d.tried_not_reached, ratio(d.tried_not_reached, d.leads)), cell(d.not_attempted, ratio(d.not_attempted, d.leads)), cell(d.confirmed, ratio(d.confirmed, d.leads)), cell(d.cancelled, ratio(d.cancelled, d.leads)), cell(d.not_confirmed, ratio(d.not_confirmed, d.leads))]; return cls ? { cls: cls, cells: c } : c; };
    return '<h3>' + esc(title || 'Day by day') + '</h3><div class="hm-sub">The same dates as the filter above. Every percentage is a share of that day\'s orders, and the days add up to the Total row.</div>' +
      table(['Order date', 'Leads', 'Attempted', 'Connected', 'Not connected', 'Not attempted', 'Confirmed', 'Cancelled', 'Not confirmed'], rows.map(function (d) { return line(dayLabel(d.day), d); }).concat([line('Total', tot, 'tot')]));
  }
  // Road to 95% (lib/road95.js): every day's orders must reach 95 percent confirmed, and each day has 5 days to get there.
  function roadHtml(R) {
    if (!R || !R.days || !R.days.length) return '';
    var st = { on_target: '<b style="color:var(--ds-brand)">On target</b>', in_progress: 'Working on it', missed: '<b style="color:var(--ds-danger)">Below 95%</b>' };
    var rows = R.days.map(function (d) { return [dayLabel(d.day), num(d.orders), cell(d.confirmed, d.confirmed_pct), cell(d.cancelled, d.cancelled_pct), cell(d.open, d.open_pct), d.days_left ? num(d.days_left) + (d.days_left === 1 ? ' day' : ' days') : 'closed', d.need ? '<b>' + num(d.need) + '</b>' : '0', st[d.state] || '']; });
    var b = R.stuck.buckets;
    var list = (R.stuck.list || []).slice(0, 15).map(function (x) { var t = x.tries; return [esc(x.order), dayLabel(x.day), num(x.waiting_hours) + ' h', num(x.attempts), 'A ' + num(t.aman) + ' · C ' + num(t.cc) + ' · I ' + num(t.ivr) + ' · W ' + num(t.wa), x.last_try_by ? esc(x.last_try_by) + (x.last_try_hours_ago != null ? ', ' + num(x.last_try_hours_ago) + ' h ago' : '') : 'nobody yet']; });
    return '<h3>Road to ' + R.target + '%: every day\'s orders</h3><div class="hm-sub">Each day\'s orders must reach <b>' + R.target + '% confirmed</b> within ' + R.mature_days + ' days. "Needs" is how many more confirmations that day still needs. The last 7 days, all channels.</div>' +
      table(['Order date', 'Orders', 'Confirmed', 'Cancelled', 'Still open', 'Days left', 'Needs', 'State'], rows, ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'm']) +
      '<div class="hm-sub"><b>' + num(R.stuck.total) + '</b> orders are still open: <b>' + num(b.none) + '</b> with no try, <b>' + num(b.one) + '</b> with one try, <b>' + num(b.two_three) + '</b> with 2 or 3 tries, <b>' + num(b.four_plus) + '</b> with 4 or more. The longest waiting first (A = Aman, C = call centre, I = IVR, W = WhatsApp, tries per channel):</div>' +
      (list.length ? table(['Order', 'Placed', 'Waiting', 'Tries', 'By channel', 'Last try'], list, ['l', 'l', 'r', 'r', 'l', 'l']) : '');
  }
  // The end-to-end check: real orders confirmed in the last 36 hours, followed from the channel that confirmed them to the report, the attempts log, the logistics gate and Shopify.
  function pipelineHtml(P) {
    if (!P) return '';
    var rows = P.channels.filter(function (c) { return c.n; }).map(function (c) {
      var cells = P.channels[0] ? c.hops.map(function (h) {
        if (!h.of) return '<span style="color:var(--ds-muted)">not asked</span>';
        var ok = h.pass === h.of; return '<b style="color:' + (ok ? 'var(--ds-brand)' : 'var(--ds-danger)') + '">' + h.pass + ' of ' + h.of + (ok ? ' ✓' : '') + '</b>' + (ok ? '' : '<div style="font-size:.75em;color:var(--ds-muted);white-space:normal">' + esc(h.bad.join(', ')) + '</div>');
      }) : [];
      return [esc(c.label), num(c.n)].concat(cells);
    });
    var head = ['Confirmed by', 'Orders checked'].concat((P.channels.filter(function (c) { return c.n; })[0] || { hops: [] }).hops.map(function (h) { return h.text; }));
    return '<h3>Do confirmed orders reach shipping? End-to-end check</h3><div class="hm-sub"><b>' + (P.failed ? num(P.failed) + (P.failed === 1 ? ' step failed' : ' steps failed') : 'Every step holds') + '</b>. Up to ' + P.sample_per_channel + ' orders per channel, confirmed in the last ' + P.window_hours + ' hours, followed through each step. ' + num(P.confirmed_in_window) + ' COD orders were confirmed in that time. Checked ' + esc(new Date(P.checked_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })) + (P.shopify_read ? '' : '. Shopify could not be read just now, so the tag step uses the CRM\'s own flag only') + '.</div>' +
      (rows.length ? table(head, rows) : '<div class="hm-sub">No orders were confirmed in the last ' + P.window_hours + ' hours.</div>');
  }
  // The definitions, in plain words, so every number on the page has one meaning.
  function definitionsHtml(L) {
    if (!L || !L.definitions) return '';
    return '<h3>What the words mean</h3><div class="hm-sub">One meaning for each word, on every page.</div>' + table(['Word', 'Meaning'], L.definitions.map(function (d) { return ['<b>' + esc(d[0]) + '</b>', esc(d[1])]; }), ['l', 'm']);
  }  // Customers who asked to cancel on the IVR or WhatsApp. Nothing is cancelled by a key or a button: a caller calls, tries to save the order, and cancels only if the customer says so.
  function cancelAsksHtml(C) {
    if (!C || !C.waiting) return '';
    return '<h3>Asked to cancel on the IVR or WhatsApp: waiting for a caller</h3><div class="hm-sub"><b>' + num(C.waiting) + '</b> orders (IVR ' + num(C.by_channel.IVR) + ', WhatsApp ' + num(C.by_channel.WhatsApp) + '). <b>' + num(C.overdue_2h) + '</b> have waited over 2 hours, <b>' + num(C.never_called_since) + '</b> have had no call since the request. They are callbacks due now at the top of the caller\'s queue. The order is cancelled only if the customer says so on the call.</div>' +
      table(['Order', 'Asked on', 'Lead of', 'Waiting', 'Calls since'], C.list.slice(0, 12).map(function (x) { return [esc(x.order), esc(x.channel), esc(x.team), num(x.waiting_hours) + ' h', num(x.calls_since)]; }), ['l', 'l', 'l', 'r', 'r']);
  }  function funnelDays(F, LR) {
    var tot = ['<b>Total</b>', '<b>' + num(F.orders) + '</b>', cell(F.attempted, F.attempted_pct), cell(F.connected, F.connected_pct), cell(F.not_connected, F.not_connected_pct), cell(F.confirmed, F.confirmed_pct), cell(F.cancelled, F.cancelled_pct), cell(F.pending, F.pending_pct)];
    var days = (F.days || []).map(function (d) { return [dayLabel(d.day), num(d.orders), cell(d.attempted, d.attempted_pct), cell(d.connected, d.connected_pct), cell(d.not_connected, d.not_connected_pct), cell(d.confirmed, d.confirmed_pct), cell(d.cancelled, d.cancelled_pct), cell(d.pending, d.pending_pct)]; });
    return (LR ? ledgerDays(LR) : ('<h3>Day by day</h3><div class="hm-sub">The same dates as the filter above. Every percentage is a share of that day\'s orders.</div>' +
      table(['Order date', 'Orders', 'Attempted', 'Connected', 'Not connected', 'Confirmed', 'Cancelled', 'Still pending'], days.concat(days.length ? [tot] : [])))) +
      '<h3>Same-day shipping by day</h3><div class="hm-sub">Orders placed before 1 PM and confirmed before the 2 PM lock, for the same dates.</div>' +
      table(['Order date', 'Placed before 1 PM', 'Confirmed before 2 PM', '% ready to ship the same day'], (F.days || []).map(function (d) { return [dayLabel(d.day), num(d.ship_pool), num(d.same_day_confirmed), pc(d.same_day_confirmed_pct)]; }).concat((F.days || []).length ? [['<b>Total</b>', '<b>' + num(F.ship_pool) + '</b>', '<b>' + num(F.same_day_confirmed) + '</b>', '<b>' + pc(F.same_day_confirmed_pct) + '</b>']] : []));
  }
  // Every order with no attempt, and why. The CSV lets the owner check each one against what the callers say.
  function auditBlock(A) {
    if (!A) return '';
    var h = '<h3>Orders with no attempt</h3><div class="hm-sub"><b>' + num(A.no_attempt) + '</b> of ' + num(A.orders) + ' orders have no attempt on any channel: no call, no IVR call, no WhatsApp (' + num(A.no_attempt_pending) + ' of them still pending). ' +
      '<a href="/api/cc/lead-audit.csv?from=' + S.from + '&to=' + S.to + '" style="font-weight:700">Download the full list (CSV)</a>, then compare it with what the callers say.</div>';
    h += A.reasons.length ? table(['Why there is no attempt', 'Aman', 'Call centre', 'Older than a day', 'Total'], A.reasons.map(function (x) { return [esc(x.reason), num(x.aman), num(x.cc), num(x.older_than_1_day), '<b>' + num(x.total) + '</b>']; })) : '<div class="hm-sub">Every order in these dates has had an attempt.</div>';
    if (A.outside_total) h += '<div class="hm-flag bad"><b>' + num(A.outside_total) + ' real COD tea orders in these dates are not counted in this report</b> because they belong to neither Aman nor the call centre (' + A.outside_report.map(function (x) { return esc(x.team) + ' / ' + esc(x.status) + ': ' + num(x.n); }).join(', ') + '). Nobody has these in a queue.</div>';
    return h;
  }
  // What the worker's last answer means, in plain words.
  var WHY = { mode_off: 'IVR_MODE is off in the worker, so it places nothing', mode_dry: 'IVR_MODE is "dry" in the worker: it only plans', paused: 'the "Pause IVR calls" button is on',
    window_closed: 'nothing to place right now. From 9 AM to 6 PM Aman and the call centre work the fresh leads, the IVR does not. New orders go to the IVR only in the 7 to 9 AM and 6 to 10 PM windows, and no-answer retries only in the best hours',
    not_set_up: 'a setting is missing in the worker' };
  function whyIvr(r, tk) { return (WHY[r] || r) + (r === 'not_set_up' && tk && tk.missing && tk.missing.length ? ' (' + tk.missing.join(', ') + ')' : ''); }
  var NO_FUNNEL ='<div class="hm-sub">The new report is not ready on the server yet. Refresh this page in a minute.</div>';

  function viewOverall() {
    var T = S.team, C = T.channels, F = T.funnel && T.funnel.overall;
    if (!F) return NO_FUNNEL;
    var a = T.aman, c = T.cc;
    var Ld = S.ledger;
    var h = (Ld ? checksHtml(Ld) + roadHtml(S.road) + cancelAsksHtml(S.cancelAsks) + pipelineHtml(S.pipe) + codTable(Ld) + gridHtml(Ld) : funnelBlock(F, 'COD tea orders placed on the chosen dates', 'overall', breakdownHtml(T.funnel.breakdown, T.funnel))) + twoPmHtml(S.twoPm) + (Ld ? ageHtml(Ld) : '') + shopifyHtml(S.shop) + (Ld ? funnelBlock(F, '', 'overall', '', true) : '') + auditBlock(S.audit);
    h += '<h3>Who confirmed the orders</h3><div class="hm-sub">Every COD order, whoever or whatever confirmed it. The IVR and WhatsApp are counted from the CRM, once.</div>' +
      table(['Channel', 'Confirmed', '% of orders', 'Share of confirmed', 'Cancelled'], C.channels.map(function (x) { return [esc(x.label), num(x.confirmed), pc(x.confirmed_pct_of_cod), pc(x.share_of_confirmed_pct), num(x.cancelled)]; }));
    var flags = (a.flags || []).map(function (f) { return { level: f.level, text: 'Aman: ' + f.text }; }).concat((c.flags || []).map(function (f) { return { level: f.level, text: 'Call centre: ' + f.text }; }));
    flags.sort(function (x, y) { return (x.level === 'bad' ? 0 : 1) - (y.level === 'bad' ? 0 : 1); });
    h += '<h3>What needs attention</h3>' + flagsHtml(flags.slice(0, 6));
    h += funnelDays(F, Ld ? Ld.days.total : null);
    h += definitionsHtml(Ld);
    return h;
  }

  function viewTeam(key) {
    var T = S.team[key], act = T.activity, F = S.team.funnel && S.team.funnel[key];
    if (!F) return NO_FUNNEL;
    var Ld = S.ledger;
    var h = Ld ? teamLedgerHtml(Ld, key) + funnelBlock(F, '', key, '', true) : funnelBlock(F, 'all COD tea orders on the chosen dates', key, ownedHtml(S.team.funnel.breakdown, key));
    h += '<h3>Work done</h3><div class="hm-grid">' +
      card('First call within 1 hour', pc(T.metrics.on_time_pct), 'new orders placed before 5 PM: first call within 1 hour of the order (or of 9 AM)', kpiTone(T.kpis, 'on_time')) +
      card('Call pick-up rate', pc(act.picked_pct), num(act.picked) + ' of ' + num(act.calls) + ' calls picked up (calls, not orders)') +
      card('Calls per person per day', act.calls_per_person_day == null ? '—' : act.calls_per_person_day, num(act.calls) + ' calls, ' + num(act.people) + ' people') + '</div>';
    h += '<h3>What needs attention</h3>' + flagsHtml(T.flags || []);
    h += '<h3>People</h3>' + table(['Name', 'Calls', 'Picked up %', 'No answer %', 'Confirmed', 'Cancelled', 'Cancel % of spoke', 'Calls per day'],
      (T.people || []).map(function (p) { return [esc(p.name), num(p.calls), pc(p.picked_pct), pc(p.dnp_pct), num(p.confirmed), num(p.cancelled), pc(p.cancel_of_spoke_pct), p.calls_per_day == null ? '—' : p.calls_per_day]; }));
    h += Ld ? ledgerDays(Ld.days[key], 'Day by day: ' + (key === 'aman' ? 'Aman\'s' : 'the call centre\'s') + ' leads') : funnelDays(F);
    return h;
  }
  function viewIvr() {
    var C = S.team.channels, row = C.channels.filter(function (x) { return x.key === 'ivr'; })[0] || { confirmed: 0, confirmed_pct_of_cod: null, share_of_confirmed_pct: null };
    var I = S.ivr, L = S.live, h = '';
    if (L) {
      var tk = L.last_tick, st = L.stats || {};
      h += '<div class="hm-live"><b>Today, live:</b> IVR is <b>' + (L.mode === 'on' ? 'LIVE' : 'not switched on in the web service (it reads IVR_MODE as: ' + esc(L.mode_raw || '') + ')') + '</b> · window ' + (L.window && L.window.open ? 'open' : 'closed') + ' · <b>' + num(L.used_today) + '</b> of ' + num(L.daily_cap) + ' calls placed · pressed 1: <b>' + num(st.k1) + '</b> · 2: <b>' + num(st.k2) + '</b> · 3: <b>' + num(st.k3) + '</b> · no key: <b>' + num(st.no_key) + '</b>' +
        (tk ? '<br>Worker last ran at ' + esc(new Date(tk.at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })) + (tk.reason ? ': ' + esc(whyIvr(tk.reason, tk)) : ': placed ' + num(tk.placed) + ', failed ' + num(tk.failed)) : '<br>The worker has not reported an IVR run yet.') + '</div>';
    }
    if (S.recent && S.recent.length) {
      var KEYW = { confirmed: 'Confirmed (1)', address_change: 'Address change (2)', cancel_requested: 'Cancel asked (3)', unknown: 'Other key' };
      h += '<h3>Live: latest IVR calls <span class="hm-sub" style="font-weight:400">updates every 30 seconds' + (S.liveAt ? ' · last at ' + esc(S.liveAt.toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })) : '') + '</span></h3>' + table(['When', 'Order', 'Number', 'Status', 'Key pressed'], S.recent.slice(0, 25).map(function (r) { var stx = r.status === 'skipped' ? 'Left to a person' : (r.status === 'failed' || r.status === 'failed_system') ? 'Request failed' : r.result ? '<b>Answered</b>' : r.status === 'placed' ? ((Date.now() - new Date(r.placed_at).getTime()) / 60000 <= 15 ? 'Calling… waiting for a key' : 'No key pressed') : esc(r.status); return [esc(new Date(r.placed_at).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })), esc((r.is_test ? 'Test ' : '') + (r.order_name || '')), esc(r.phone), stx, esc(r.result ? (KEYW[r.result] || r.result) : '')]; }));
    }
    if (S.team && S.team.funnel && S.team.funnel.ivr) h += S.ledger ? channelLedgerHtml(S.ledger, 'ivr') + funnelBlock(S.team.funnel.ivr, '', 'ivr', '', true) : funnelBlock(S.team.funnel.ivr, 'all COD tea orders on the chosen dates', 'ivr');
    if (!I) return h + '<div class="hm-err">IVR numbers are not available right now. The rest of Home still works.</div>';
    var t = I.totals;
    h += '<div class="hm-grid">' +
      card('Calls placed', num(t.placed), num(t.orders_called) + ' orders called') +
      card('Customer answered', pc(t.pressed_pct), num(t.pressed) + ' pressed a key') +
      card('Confirmed (pressed 1)', num(t.k1), pc(t.confirm_pct_of_placed) + ' of calls', 'ok') +
      card('Wants address change (2)', num(t.k2), 'a caller phones back') +
      card('Asked to cancel (3)', num(t.k3), 'not cancelled: a caller tries to save it') +
      card('No key pressed', num(t.no_key), pc(t.no_key_pct) + ' of calls: not answered or hung up') +
      card('Left to a person', num(t.left_to_person), 'risky order, bad address or phone') +
      card('Request failed', num(t.failed), 'refused by the IVR service') + '</div>';
    h += '<div class="hm-grid">' + card('Orders confirmed on IVR', num(row.confirmed), 'of orders PLACED in these dates: ' + pc(row.confirmed_pct_of_cod) + ' of COD orders, ' + pc(row.share_of_confirmed_pct) + ' of confirmations. Older orders confirmed in these dates are in the next box.') +
      card('Confirmed in the CRM from a press', num(t.confirmed_applied), 'order was still pending, so it was confirmed') + '</div>';
    h += '<div class="hm-sub">A cancel request (key 3) never cancels an order by itself. A caller phones the customer to save the order, and cancels only if the customer says so on the call. So the IVR does not add to your cancellation number.</div>';
    h += curveHtml();
    h += '<h3>Day by day</h3>' + table(['Date', 'Calls placed', 'Answered', 'Answered %', 'Pressed 1', 'Pressed 2', 'Pressed 3', 'No key', 'Left to a person'],
      I.days.map(function (d) { return [dayLabel(d.day), num(d.placed), num(d.pressed), pc(d.pressed_pct), num(d.k1), num(d.k2), num(d.k3), num(d.no_key), num(d.left_to_person)]; }));
    return h;
  }

  // When do customers pick up? Hour by hour, from the last 30 days of calls. Preview only: nothing in the calling uses it yet.
  function curveHtml() {
    var C = S.curve; if (!C) return '';
    var rows = C.hours.filter(function (x) { return x.hour >= 6 && x.hour < 23; }).map(function (x) {
      return [esc(x.label) + (x.chosen ? ' <b>★</b>' : ''), x.enough ? num(x.calls) : num(x.calls) + ' (too few)', pc(x.pickup_pct), num(x.ivr_placed), pc(x.ivr_pct), x.index == null ? '—' : x.index.toFixed(2), x.chosen ? '<b>best hour</b>' : (x.allowed ? '' : 'outside the day hours')];
    });
    var best = C.smart_hours.length ? C.smart_hours.map(function (h) { return (h % 12 || 12) + (h >= 12 ? ' PM' : ' AM'); }).join(', ') : 'not enough calls yet';
    return '<h3>Best hours to reach customers</h3><div class="hm-sub">From the last ' + C.days + ' days: ' + num(C.samples.human_calls) + ' caller calls and ' + num(C.samples.ivr_calls) + ' IVR calls. Callers picked up on average ' + pc(C.human_avg_pct) + ' of retry calls (a retry is a call at least an hour after a no-answer; first calls are not counted here), the IVR got a key press on ' + pc(C.ivr_avg_pct) + '. ' +
      '<b>Score</b> 1.00 = an average hour, 1.50 = half as good again. ★ = hours the smart campaign would use for the no-answer leads (between ' + C.rule.from + ':00 and ' + C.rule.to + ':00, at most ' + C.rule.max_hours + ' hours): <b>' + esc(best) + '</b>. <b>Preview only: nothing in the calling changes yet.</b></div>' +
      table(['Hour', 'Caller retries', 'Retries picked up', 'IVR calls', 'IVR key pressed', 'Score', ''], rows);
  }
  function viewWhatsapp() {
    var C = S.team.channels, row = C.channels.filter(function (x) { return x.key === 'whatsapp'; })[0] || { confirmed: 0, cancelled: 0 };
    var h = waReportHtml(S.wa) + (S.team.funnel && S.team.funnel.wa ? (S.ledger ? channelLedgerHtml(S.ledger, 'wa') + funnelBlock(S.team.funnel.wa, '', 'wa', '', true) : funnelBlock(S.team.funnel.wa, 'all COD tea orders on the chosen dates', 'wa')) : '') + '<div class="hm-grid">' + card('Confirmed on WhatsApp', num(row.confirmed), 'orders') + card('% of all COD orders', pc(row.confirmed_pct_of_cod), num(C.totals.cod) + ' COD orders') +
      card('Share of all confirmations', pc(row.share_of_confirmed_pct), num(C.totals.confirmed_total) + ' confirmed in total') + card('Cancelled on WhatsApp', num(row.cancelled), 'customer chose cancel') + '</div>';
    h += '<div class="hm-sub">Messages sent are not stored in the CRM: WhatsApp confirmations come in through the Google Sheet. So this view shows confirmations, not how many messages went out.</div>';
    h += '<h3>By when the order was placed</h3>' + table(['Placed', 'Orders', 'Confirmed', 'Confirmed %', 'On WhatsApp'], C.windows.map(function (w) { return [esc(w.label), num(w.orders), num(w.confirmed), pc(w.confirmed_pct), num(w.whatsapp)]; }));
    h += '<h3>Day by day</h3>' + table(['Order date', 'Orders', 'Confirmed on WhatsApp', '% of orders'], C.days.map(function (d) { return [dayLabel(d.day), num(d.cod), num(d.whatsapp), pc(d.cod ? Math.round((d.whatsapp / d.cod) * 1000) / 10 : null)]; }));
    return h;
  }

  function render() {
    var V = [['overall', 'Overall'], ['aman', 'Aman'], ['cc', 'Call centre'], ['ivr', 'IVR'], ['whatsapp', 'WhatsApp']], P = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['month', 'This month']];
    var h = '<div class="hm-top"><div class="hm-title">Home</div>' + P.map(function (x) { return '<button class="hm-btn' + (S.preset === x[0] ? ' on' : '') + '" data-p="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
      '<input class="hm-date" type="date" id="hm-from" value="' + S.from + '"><span>to</span><input class="hm-date" type="date" id="hm-to" value="' + S.to + '"><button class="hm-btn" id="hm-go">Show</button></div>' +
      '<div class="hm-views">' + V.map(function (x) { return '<button class="hm-btn' + (S.view === x[0] ? ' on' : '') + '" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
    var body;
    try { body = S.view === 'overall' ? viewOverall() : (S.view === 'aman' || S.view === 'cc') ? viewTeam(S.view) : S.view === 'ivr' ? viewIvr() : viewWhatsapp(); }
    catch (e) { body = '<div class="hm-err">This view could not be drawn: ' + esc(e.message) + '</div>'; }
    $('hm-root').innerHTML = h + '<div class="hm-sub">Dates ' + esc(S.from) + ' to ' + esc(S.to) + ' (India time), orders placed on those dates. Real COD tea orders only: test orders, orders under the minimum price and prepaid orders are left out. Older reports are under <b>More reports</b>.</div>' + body;
    [].forEach.call($('hm-root').querySelectorAll('[data-p]'), function (b) { b.onclick = function () { setPreset(b.dataset.p); load(); }; });
    [].forEach.call($('hm-root').querySelectorAll('[data-v]'), function (b) { b.onclick = function () { S.view = b.dataset.v; render(); }; });
    $('hm-go').onclick = function () { var f = $('hm-from').value, t = $('hm-to').value; if (f && t && f <= t) { S.from = f; S.to = t; S.preset = ''; load(); } };
  }

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (res.status === 401) { location.href = '/login.html?next=/admin.html'; throw new Error('login'); }
      return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Request failed'); return j; });
    });
  }
  function load() {
    $('hm-root').innerHTML = '<div class="hm-load">Loading…</div>';
    var q = '?from=' + S.from + '&to=' + S.to;
    Promise.all([getJson('/api/cc/hour-curve').catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/team-report' + q), getJson('/api/cc/ivr-report' + q).catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/ivr-plan').catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/ivr/status').catch(function () { return null; }), getJson('/api/cc/lead-audit' + q).catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/two-pm?date=' + S.to).catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/wa-report' + q).catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/ledger' + q).catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/shopify-check').catch(function (e) { if (e.message === 'login') throw e; return null; }), getJson('/api/cc/cancel-requests').catch(function (e) { if (e.message === 'login') throw e; return null; })])
      .then(function (r) { getJson('/api/cc/road-to-95').then(function (j) { S.road = j; render(); }).catch(function () {}); if (!S.pipeAsked) { S.pipeAsked = true; getJson('/api/cc/pipeline-check').then(function (j) { S.pipe = j; render(); }).catch(function () {}); } S.curve = r[0]; S.team = r[1]; S.ivr = r[2]; S.live = r[3]; S.recent = r[4] ? r[4].recent : null; S.audit = r[5]; S.twoPm = r[6]; S.wa = r[7]; S.ledger = r[8]; S.shop = r[9]; S.cancelAsks = r[10]; S.liveAt = new Date(); render(); })
      .catch(function (e) { if (e.message !== 'login') $('hm-root').innerHTML = '<div class="hm-err">' + esc(e.message) + '</div>'; });
  }

  // Live: while the IVR view is open the numbers and the latest calls refresh by themselves every 30 seconds.
  function refreshLive() {
    Promise.all([getJson('/api/cc/ivr-plan').catch(function () { return null; }), getJson('/api/cc/ivr-report?from=' + S.from + '&to=' + S.to).catch(function () { return null; }), getJson('/api/cc/ivr/status').catch(function () { return null; })])
      .then(function (r) { if (r[0]) S.live = r[0]; if (r[1]) S.ivr = r[1]; if (r[2]) S.recent = r[2].recent; S.liveAt = new Date(); if (S.view === 'ivr' && pane.classList.contains('active') && S.team) render(); });
  }
  setInterval(function () { if (!document.hidden && pane.classList.contains('active') && S.view === 'ivr') refreshLive(); }, 30000);

  pane.innerHTML = '<div class="hm" id="hm-root"></div>';
  tab.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    tab.classList.add('active'); pane.classList.add('active'); load();
  };

  // Keep the tab bar short: Home, Call plan and Agents stay; every older report moves under "More reports".
  function regroup() {
    var KEEP = ['home', 'plan', 'agents'], all = [].slice.call(tabsEl.querySelectorAll('.tab'));
    var more = document.createElement('div'); more.className = 'tab'; more.id = 'tab-more'; more.textContent = 'More reports ▾'; tabsEl.appendChild(more);
    var menu = document.createElement('div'); menu.id = 'hm-menu'; document.body.appendChild(menu);
    all.forEach(function (x) {
      if (KEEP.indexOf(x.dataset.p) !== -1) return;
      x.style.display = 'none';
      var b = document.createElement('button'); b.textContent = x.textContent;
      b.onclick = function () { menu.style.display = 'none'; x.click(); setTimeout(sync, 0); };
      menu.appendChild(b);
    });
    function sync() {
      var hidden = all.filter(function (x) { return x.style.display === 'none' && x.classList.contains('active'); })[0];
      more.classList.toggle('active', !!hidden); more.textContent = hidden ? 'More: ' + hidden.textContent + ' ▾' : 'More reports ▾';
      if (hidden) { more.classList.add('active'); }
    }
    more.onclick = function (e) {
      e.stopPropagation();
      if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
      var r = more.getBoundingClientRect(); menu.style.top = (r.bottom + 4) + 'px'; menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 220)) + 'px'; menu.style.display = 'block';
    };
    document.addEventListener('click', function () { menu.style.display = 'none'; });
    tabsEl.addEventListener('click', function () { setTimeout(sync, 0); });
  }
  regroup();
  tab.click();
})();
