/* Admin "Call plan": calls needed today against calls the teams can make, tries per DNP lead (3 to 5 by bandwidth), balancing, and the
   "stop redialling" list. Data: /api/cc/load-plan (rules in lib/loadPlan.js). Uses helpers from admin.html ($, esc). */
(function () {
  var TZ = 'Asia/Kolkata';
  var tabsEl = $('tabs'), anchor = $('p-log');
  var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = 'plan'; t.textContent = 'Call plan';
  tabsEl.insertBefore(t, tabsEl.firstChild);
  var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-plan'; anchor.parentNode.appendChild(p);

  var css = '.cp{padding:6px 0 28px;color:var(--ds-text)}.cp-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.cp-title{font-size:1.25rem;font-weight:800;margin-right:auto}' +
    '.cp-btn{background:var(--ds-surface);color:var(--ds-text);border:1px solid var(--ds-border-strong);border-radius:8px;padding:9px 14px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}' +
    '.cp-btn.main{background:var(--ds-brand);border-color:var(--ds-brand);color:#fff}.cp-btn[disabled]{opacity:.5;cursor:default}' +
    '.cp-banner{border-radius:10px;padding:14px 16px;margin-bottom:14px;font-weight:800;font-size:1.0625rem}.cp-banner small{display:block;font-weight:500;font-size:0.8125rem;margin-top:2px}' +
    '.cp-banner.ok{background:var(--ds-brand-tint);color:var(--ds-brand-strong)}.cp-banner.bad{background:var(--ds-danger-tint);color:var(--ds-danger)}.cp-banner.warn{background:var(--ds-warn-tint);color:var(--ds-warn-ink)}' +
    '.cp h3{font-size:1rem;font-weight:800;margin:22px 0 4px}.cp-sub{font-size:0.75rem;color:var(--ds-muted);margin-bottom:8px;line-height:1.5}' +
    '.cp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.cp-card{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:14px}' +
    '.cp-card.ok{border-color:#b9d9c5}.cp-card.warn{border-color:#ecd68a}.cp-card.bad{border-color:#e8b4b4}.cp-card .n{font-weight:800;font-size:1.0625rem;margin-bottom:2px}' +
    '.cp-goal{font-size:1.5rem;font-weight:800;margin:6px 0 2px;font-variant-numeric:tabular-nums}.cp-goal small{font-size:0.8125rem;font-weight:600;color:var(--ds-muted)}' +
    '.cp-card .r{display:flex;justify-content:space-between;font-size:0.875rem;padding:3px 0;color:var(--ds-muted)}.cp-card .r b{color:var(--ds-text);font-variant-numeric:tabular-nums}' +
    '.cp-adv{margin-top:8px;font-size:0.8125rem;line-height:1.45;padding-top:8px;border-top:1px solid var(--ds-border)}' +
    '.cp-box{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;padding:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.cp-box span{flex:1;min-width:220px;font-size:0.875rem;line-height:1.5}' +
    '.cp-tbl{width:100%;border-collapse:collapse;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:8px;font-size:0.875rem}.cp-tbl th,.cp-tbl td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--ds-border);font-variant-numeric:tabular-nums}' +
    '.cp-tbl th:first-child,.cp-tbl td:first-child{text-align:left}.cp-tbl th{font-size:0.75rem;color:var(--ds-muted);font-weight:700}' +
    '.cp-chip{display:inline-block;font-size:0.6875rem;font-weight:800;border-radius:999px;padding:3px 9px;background:var(--ds-border);color:var(--ds-muted);vertical-align:middle;margin-left:6px}.cp-chip.on{background:var(--ds-brand-tint);color:var(--ds-brand-strong)}' +
    '.cp-in{display:flex;flex-direction:column;gap:4px;font-size:0.75rem;font-weight:700;color:var(--ds-muted)}.cp-in input{width:130px;padding:9px 10px;border:1px solid var(--ds-border-strong);border-radius:8px;background:var(--ds-surface);color:var(--ds-text);font-size:1rem;font-family:inherit}' +
    '.cp-hlbox{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:10px;padding:10px 14px;margin:10px 0;font-size:0.875rem}.cp-hlbox b:first-child{display:block;margin-bottom:4px}.cp-hl{padding:3px 0;line-height:1.45}.cp-hl.ok{color:var(--ds-brand-strong)}.cp-hl.bad{color:var(--ds-danger);font-weight:700}' +
    '.cp-msg{margin-top:8px;font-size:0.875rem;font-weight:700}.cp-err{background:var(--ds-danger-tint);color:var(--ds-danger);border-radius:8px;padding:10px 12px}.cp-load{padding:30px;text-align:center;color:var(--ds-muted)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function num(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }

  function teamCard(x, min, max) {
    var d = x.demand, rows = '';
    for (var L = min; L <= max; L++) rows += '<div class="r"><span>Calls needed at ' + L + ' tries per lead</span><b>' + num(d[L]) + '</b></div>';
    return '<div class="cp-card ' + x.status + '"><div class="n">' + esc(x.label) + '</div>' +
      '<div class="cp-goal">' + x.tries_today + ' tries <small>per DNP lead today</small></div>' +
      '<div class="r"><span>People on the team today (in CRM now)</span><b>' + num(x.agents_on_team) + ' (' + num(x.agents_active_now) + ')</b></div>' +
      '<div class="r"><span>Calls per person per hour (' + (x.rate_source === 'measured' ? 'measured' : 'assumed') + ')</span><b>' + x.calls_per_hour + '</b></div>' +
      '<div class="r"><span>Calls they can still make today</span><b>' + num(x.capacity) + '</b></div>' + rows +
      '<div class="r"><span>Never called</span><b>' + num(x.never_called) + '</b></div><div class="r"><span>DNP leads still being tried</span><b>' + num(x.dnp_open) + '</b></div>' +
      '<div class="r"><span>Callbacks due</span><b>' + num(x.callbacks_due) + '</b></div>' +
      (x.deficit > 0 ? '<div class="r"><span>Short by (calls)</span><b style="color:var(--ds-danger)">' + num(x.deficit) + '</b></div>' : '') +
      '<div class="cp-adv">' + esc(x.advice) + '</div></div>';
  }

  function render(d) {
    var cc = d.teams.cc, am = d.teams.aman, s = d.settings, h = '';
    var bad = [cc, am].filter(function (x) { return x.status === 'bad'; }), tone = bad.length ? 'bad' : ([cc, am].some(function (x) { return x.status === 'warn'; }) ? 'warn' : 'ok');
    var head = bad.length ? bad.map(function (x) { return x.label + ' is short by about ' + num(x.deficit) + ' calls today'; }).join(' · ') : (tone === 'warn' ? 'Tight: the teams can just finish today\'s calls' : 'Both teams can finish today\'s calls');
    h += '<div class="cp-banner ' + tone + '">' + esc(head) + '<small>' + (d.hours_left > 0 ? d.hours_left + ' hours left in today\'s shift (' + s_h(d.shift.start) + '–' + s_h(d.shift.end) + ')' : 'The shift is over') + ' · goal is ' + s.min_tries + ' tries per DNP lead, up to ' + s.max_tries + ' when there is time</small></div>';
    h += '<div class="cp-grid">' + teamCard(cc, s.min_tries, s.max_tries) + teamCard(am, s.min_tries, s.max_tries) + '</div>';
    var mv = d.move_direction || {}, mc = d.move_count || 0;
    h += '<h3>Balance the load</h3><div class="cp-sub">Leads move only from the team that cannot finish today to the team that has time to spare. Leads that have waited longest move first. Callbacks and leads already spoken to stay where they are.</div>';
    h += '<div class="cp-box"><span>' + (mc ? '<b>' + num(mc) + ' leads</b> can move: ' + (mv.cc_to_aman ? num(mv.cc_to_aman) + ' from Call centre to Aman' : '') + (mv.cc_to_aman && mv.aman_to_cc ? ', ' : '') + (mv.aman_to_cc ? num(mv.aman_to_cc) + ' from Aman to Call centre' : '') + '.' : 'Nothing needs to move right now.') +
      '<br><span style="font-size:0.75rem;color:var(--ds-muted)">Autopilot is <b>' + esc(d.autopilot_mode) + '</b>' + (d.autopilot_mode === 'on' ? ': it does this by itself every 10 minutes.' : (d.autopilot_mode === 'dry' ? ': it only plans. Set AUTOPILOT=on in Railway for it to move leads by itself.' : '.')) + '</span></span>' +
      '<button class="cp-btn main" id="cp-apply"' + (mc ? '' : ' disabled') + '>Move these leads now</button></div><div class="cp-msg" id="cp-msg"></div>';
    if (d.split && d.split.is_admin) {
      var sp = d.split, half = Math.max(0, Math.floor((sp.cc - sp.aman) / 2));
      h += '<h3>Split the old backlog</h3><div class="cp-sub">Old leads are the ones placed before today that can still be called. Leads never called go first, then the ones with the fewest unanswered tries, then the ones that have waited longest. Callbacks, leads already spoken to and leads over the limit stay where they are. Today\'s new orders are not touched.</div>' +
        '<div class="cp-box"><span>Old leads now: <b>' + num(sp.cc) + '</b> with the Call centre, <b>' + num(sp.aman) + '</b> with Aman.</span>' +
        '<label class="cp-in">Move to Aman <input type="number" min="0" max="500" id="cp-s-aman" value="' + half + '"></label>' +
        '<label class="cp-in">Move to Call centre <input type="number" min="0" max="500" id="cp-s-cc" value="0"></label>' +
        '<button class="cp-btn main" id="cp-split">Move these leads</button></div><div class="cp-msg" id="cp-smsg"></div>';
    }
    h += '<h3>Open leads by number of tries</h3><div class="cp-sub">Leads already spoken to are not counted.</div><table class="cp-tbl"><tr><th>Where the lead stands</th><th>Call centre</th><th>Aman</th><th>Total</th></tr>' +
      d.backlog.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td>' + num(r.cc) + '</td><td>' + num(r.aman) + '</td><td><b>' + num(r.cc + r.aman) + '</b></td></tr>'; }).join('') + '</table>';
    h += '<h3>Stop redialling: send WhatsApp / IVR, then review</h3><div class="cp-sub">A lead goes on this list after ' + s.give_up_tries + ' unanswered tries over at least ' + s.give_up_days + ' days. It leaves the calling queue. Nothing is cancelled automatically: you or Aman decide after the message goes out.</div>' +
      '<div class="cp-box"><span><b>' + num(d.review_count) + '</b> leads on the list.</span>' + (d.review_count ? '<a class="cp-btn" href="/api/cc/load-plan/review.csv">Download the list (Excel / CSV)</a>' : '') + '</div>';
    h += '<div id="cp-ivr"></div>';
    $('cp-body').innerHTML = h;
    loadIvr();
    var b = $('cp-apply'); if (b) b.onclick = apply;
    var sb = $('cp-split'); if (sb) sb.onclick = split;
  }

  // IVR list (stage 1: preview only, no calls are placed).
  function hourLabel(n) { return s_h(n); }
  function loadIvr() {
    var box = $('cp-ivr'); if (!box) return;
    fetch('/api/cc/ivr-plan').then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not load the IVR plan'); return j; }); }).then(function (v) {
      var GN = { fresh: 'Fresh orders (never called, called first)', today: 'Placed today', recent: 'Placed in the last few days', backlog: 'Older backlog' }, WHY = { spoken_to: 'Already spoken to', callback: 'Callback promised', person_called_recently: 'A person called in the last 3 hours', ivr_done: 'IVR has already tried the maximum', ivr_too_soon: 'IVR tried a little while ago', over_the_limit: 'Over the limit: a person decides', left_to_person: 'Left to a person (risky, or address or phone not good enough)' };
      var w = v.window, wins = v.windows.map(function (x) { return hourLabel(x.start) + '–' + hourLabel(x.end); }).join(' and ');
      var h = '<h3>IVR list <span class="cp-chip' + (v.mode === 'on' ? ' on' : '') + '">' + (v.mode === 'on' ? 'LIVE' : (v.mode === 'dry' ? 'DRY RUN' : 'NOT CONNECTED')) + '</span></h3>' +
        '<div class="cp-sub"><b>New orders:</b> the IVR calls them in the fixed windows, ' + esc(wins) + ' (India time). ' + (v.smart ? '<b>No-answer leads:</b> it also works them in the best hours of the day (between ' + v.smart_from + ':00 and ' + v.smart_to + ':00), chosen automatically from your call data, one try per lead per day (' + v.max_tries + ' in total). ' : '') +
          'At most ' + num(v.daily_cap) + ' calls per day: <b>this ceiling is set in Railway (IVR_DAILY_CAP) and stops all calls once it is reached.</b> It only takes leads that no person is working on, with a valid address and low risk. ' + (v.mode === 'on' ? '<b>Live:</b> it places calls by itself.' : '<b>This page says "not connected" because IVR_MODE is not set to on in the web service.</b> The list below is what the IVR would take, and you can download it.') + '</div>' +
        '<div class="cp-box"><span>' + (v.cover ? '<b>Cover day is ON:</b> nobody from Aman or the call centre is working, so the IVR calls new orders now and the old no-answer leads in the best hours (cap ' + num(v.daily_cap) + '). It switches off by itself when a caller opens the CRM.<br>' : '') + (w.open ? 'The IVR window is <b>open</b> now.' : 'The IVR window is <b>closed</b> now. Next opens at ' + hourLabel(w.nextStartHour) + (w.tomorrow ? ' tomorrow' : '') + '.') + '<br><b>' + num(v.ready_total) + '</b> leads are free for the IVR' + (v.cut_by_cap ? ' (' + num(v.in_list) + ' in the list, ' + num(v.cut_by_cap) + ' over the cap)' : '') + '.</span>' +
        (v.is_admin && v.in_list ? '<a class="cp-btn" href="/api/cc/ivr-plan/list.csv?group=all">Download the list (CSV)</a>' : '') + '</div>';
      var tk = v.last_tick, SK = { bad_phone: 'bad phone number', same_phone_called: 'phone already called', no_pincode: 'no valid pincode', short_address: 'address too short', not_pending: 'no longer pending', risk_medium: 'medium risk', risk_high: 'high risk' }, tline;
      if (!tk) tline = '<b style="color:var(--ds-danger)">The worker has not reported any IVR run yet.</b> Check that <b>IVR_MODE = on</b> is set on the <b>worker</b> service in Railway and that the worker was redeployed.';
      else {
        var ageMin = Math.round((Date.now() - new Date(tk.at).getTime()) / 60000), when = new Date(tk.at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
        if (ageMin > 5) tline = '<b style="color:var(--ds-danger)">The worker last ran the IVR job ' + ageMin + ' minutes ago (' + when + ').</b> It should run every minute: check the worker service in Railway.';
        else if (tk.reason) tline = 'Worker ran at ' + when + ': ' + ({ paused: 'paused with the Pause button.', window_closed: 'waiting, it is outside the IVR hours (normal).', not_set_up: '<b style="color:var(--ds-danger)">missing in the worker: ' + esc((tk.missing || []).join(', ')) + '.</b>' }[tk.reason] || ('<b style="color:var(--ds-danger)">IVR_MODE is not "on" in the worker (' + esc(tk.reason) + ').</b>'));
        else tline = 'Worker ran at ' + when + ': placed <b>' + num(tk.placed) + '</b>, failed <b>' + num(tk.failed) + '</b>' + (Object.keys(tk.lead_skips || {}).length ? ', skipped ' + Object.keys(tk.lead_skips).map(function (k) { return num(tk.lead_skips[k]) + ' ' + esc(SK[k] || k); }).join(', ') : '') + '.' + (tk.stopped ? ' <b style="color:var(--ds-danger)">Stopped: ' + esc(tk.stopped) + (tk.last_error ? ' (' + esc(tk.last_error) + ')' : '') + '</b>' : '');
      }
      if (tk && tk.auto_hold) tline += '<br>Automatic hold at ' + esc(new Date(tk.auto_hold.at).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + ': <b>' + num(tk.auto_hold.held) + '</b> leads held for the IVR' + (tk.auto_hold.already ? ' (' + num(tk.auto_hold.already) + ' already on hold)' : '') + '.';
      h += '<div class="cp-sub" style="margin-top:8px">' + tline + '</div>';
      var st = v.stats || {};
      // System check: everything that must be true for the IVR to call, in one list. A red line says what to fix.
      var hl = [], ageW = tk ? Math.round((Date.now() - new Date(tk.at).getTime()) / 60000) : null, wk = tk && tk.worker;
      var chk = function (ok, text) { hl.push('<div class="cp-hl ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✔ ' : '✖ ') + text + '</div>'); };
      chk(v.mode === 'on', 'Web service: IVR_MODE ' + (v.mode === 'on' ? 'is <b>on</b>' : 'is <b>not on</b>: it reads <b>' + esc(v.mode_raw || '') + '</b>. Set IVR_MODE = on on the web service and press Deploy.'));
      chk(v.daily_cap >= 100, 'Web service: daily cap <b>' + num(v.daily_cap) + '</b>' + (v.daily_cap < 100 ? ' (too low: set IVR_DAILY_CAP, for example 900, and press Deploy)' : ''));
      chk(!!tk && ageW <= 3, tk ? 'Worker is running (last run ' + ageW + ' min ago)' : 'The worker has not reported any run: check the worker service in Railway');
      if (wk) {
        chk(wk.mode === 'on', 'Worker: IVR_MODE ' + (wk.mode === 'on' ? 'is <b>on</b>' : 'is <b>not on</b>: set IVR_MODE = on on the worker and press Deploy'));
        chk(wk.cap >= 100, 'Worker: daily cap <b>' + num(wk.cap) + '</b>' + (wk.cap < 100 ? ' (too low: set IVR_DAILY_CAP on the worker and press Deploy)' : ''));
        chk(wk.mode === v.mode && wk.cap === v.daily_cap, 'Web and worker settings ' + (wk.mode === v.mode && wk.cap === v.daily_cap ? '<b>agree</b>' : '<b>differ</b> (web: ' + esc(v.mode) + ', cap ' + num(v.daily_cap) + '; worker: ' + esc(wk.mode) + ', cap ' + num(wk.cap) + '). Make them the same.'));
      }
      chk(!(st.failed > 0), 'Requests the IVR service refused today: <b>' + num(st.failed) + '</b>' + (st.failed > 0 ? ' (check the IVR Solutions wallet balance and the error in the Worker line)' : ''));
      h += '<div class="cp-hlbox"><b>System check</b>' + hl.join('') + '</div>';
      h += '<div class="cp-sub" style="margin-top:8px">Today: <b>' + num(v.used_today) + '</b> of ' + num(v.daily_cap) + ' calls placed · pressed 1 (confirmed) <b>' + num(st.k1) + '</b> · pressed 2 (address) <b>' + num(st.k2) + '</b> · pressed 3 (cancel) <b>' + num(st.k3) + '</b> · no key pressed <b>' + num(st.no_key) + '</b> · request failed <b>' + num(st.failed) + '</b> · left to a person (risk or address) <b>' + num(st.left_to_person) + '</b>' + (st.paused ? ' · <b style="color:var(--ds-danger)">PAUSED</b>' : '') + '</div>';
      if (v.is_admin && v.mode === 'on') h += '<div class="cp-box"><span>' + (st.paused ? 'Real IVR calls are <b>paused</b>.' : 'Emergency stop: stops all real IVR calls at once.') + '</span><button class="cp-btn" id="cp-pause">' + (st.paused ? 'Resume IVR calls' : 'Pause IVR calls') + '</button></div><div class="cp-msg" id="cp-pmsg"></div>';
      if (v.is_admin) h += '<h3>Send old no-answer leads to the IVR</h3><div class="cp-sub">Holds old leads (no answer from the callers) for the IVR, so Aman and the call centre do not see them. Only leads the IVR can really call are held: a valid phone, a deliverable address and low risk. Everything else stays with the callers. A hold ends by itself after the hours you choose, and leads come back to the callers when the IVR has used its tries, the customer answers, or you press Release. Today the IVR has <b>' + num(v.held) + '</b> leads on hold.</div>' +
        '<div class="cp-box"><label class="cp-in">How many leads <input type="number" min="1" max="2000" id="cp-h-n" value="300"></label><label class="cp-in">Hold for (hours) <input type="number" min="1" max="168" id="cp-h-h" value="48"></label>' +
        '<button class="cp-btn main" id="cp-holdgo">Hold these leads and start calling now</button><button class="cp-btn" id="cp-hold">Hold only</button><button class="cp-btn" id="cp-release">Release all held leads</button></div>' +
        '<div class="cp-box"><span>' + (v.force_until ? '<b>Start now is ON</b> until ' + esc(new Date(v.force_until).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })) + ': the IVR calls the no-answer leads now, one try per lead per day, up to 10 a minute, inside 9 AM to 9 PM and the daily cap.' : 'Outside the best hours the IVR waits. <b>Start now</b> makes it call the no-answer leads straight away for 2 hours (9 AM to 9 PM only).') + '</span>' +
        '<button class="cp-btn main" id="cp-start">Start no-answer calls now (2 hours)</button><button class="cp-btn" id="cp-stop">Stop starting now</button></div><div class="cp-msg" id="cp-hmsg"></div>';
      if (v.groups.length) h += '<table class="cp-tbl"><tr><th>Where the lead stands</th><th>Never called</th><th>People tried, no answer</th><th>Total</th></tr>' + v.groups.map(function (g) { return '<tr><td>' + esc(GN[g.group] || g.group) + '</td><td>' + num(g.never) + '</td><td>' + num(g.dnp) + '</td><td><b>' + num(g.total) + '</b></td></tr>'; }).join('') + '</table>';
      var bl = Object.keys(v.blocked || {}); if (bl.length) h += '<div class="cp-sub" style="margin-top:8px">Left to people: ' + bl.map(function (k) { return num(v.blocked[k]) + ' ' + esc((WHY[k] || k).toLowerCase()); }).join(' · ') + '.</div>';
      box.innerHTML = h + (v.is_admin ? '<div id="cp-ivrtools"></div>' : '');
      if (v.is_admin) loadIvrTools();
      var hb = $('cp-hold'); if (hb) hb.onclick = function () {
        var n = parseInt($('cp-h-n').value, 10) || 0, hrs = parseInt($('cp-h-h').value, 10) || 48, m = $('cp-hmsg');
        if (!n) { m.textContent = 'Enter how many leads.'; return; }
        if (!confirm('Hold up to ' + n + ' old no-answer leads for the IVR for ' + hrs + ' hours? The callers will not see them until the hold ends or you release them.')) return;
        hb.disabled = true; m.textContent = 'Holding…';
        fetch('/api/cc/ivr/hold-backlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: n, hours: hrs }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not hold the leads'); return j; }); })
          .then(function (j) { var why = Object.keys(j.left_to_person || {}).map(function (k) { return num(j.left_to_person[k]) + ' ' + k.replace(/_/g, ' '); }).join(', ');
            m.textContent = num(j.held) + ' leads are now held for the IVR for ' + j.hours + ' hours (' + num(j.candidates) + ' old leads looked at).' + (j.not_free ? ' ' + num(j.not_free) + ' were busy with a caller and were skipped.' : '') + (why ? ' Left with the callers: ' + why + '.' : ''); hb.disabled = false; setTimeout(loadIvr, 1500); })
          .catch(function (e) { m.textContent = e.message; hb.disabled = false; });
      };
      var postJson = function (url, body) { return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); }); };
      var go = $('cp-holdgo'); if (go) go.onclick = function () {
        var n = parseInt($('cp-h-n').value, 10) || 0, hrs = parseInt($('cp-h-h').value, 10) || 48, m = $('cp-hmsg');
        if (!n) { m.textContent = 'Enter how many leads.'; return; }
        if (!confirm('Hold up to ' + n + ' old no-answer leads for the IVR for ' + hrs + ' hours AND start the IVR calling them now? The callers will not see held leads until the hold ends or you release them.')) return;
        go.disabled = true; m.textContent = 'Holding…';
        postJson('/api/cc/ivr/hold-backlog', { count: n, hours: hrs }).then(function (j) { m.textContent = num(j.held) + ' leads held. Starting the calls…'; return postJson('/api/cc/ivr/run-now', { minutes: 120 }).then(function () { m.textContent = num(j.held) + ' leads are held, and the IVR starts calling them within a minute (9 AM to 9 PM only, one try per lead per day).'; go.disabled = false; setTimeout(loadIvr, 1500); }); })
          .catch(function (e) { m.textContent = e.message; go.disabled = false; });
      };
      var sb = $('cp-start'); if (sb) sb.onclick = function () {
        var m = $('cp-hmsg'); if (!confirm('Start the no-answer calls now for 2 hours?')) return;
        sb.disabled = true; postJson('/api/cc/ivr/run-now', { minutes: 120 }).then(function () { m.textContent = 'Started. The IVR calls the no-answer leads from now for 2 hours.'; sb.disabled = false; setTimeout(loadIvr, 1500); }).catch(function (e) { m.textContent = e.message; sb.disabled = false; });
      };
      var xb = $('cp-stop'); if (xb) xb.onclick = function () { var m = $('cp-hmsg'); postJson('/api/cc/ivr/stop-now', {}).then(function () { m.textContent = 'Start now is off. The IVR is back to the best hours only.'; setTimeout(loadIvr, 1000); }).catch(function (e) { m.textContent = e.message; }); };      var rb = $('cp-release'); if (rb) rb.onclick = function () {
        var m = $('cp-hmsg'); if (!confirm('Give ALL held leads back to the callers now?')) return;
        rb.disabled = true; m.textContent = 'Releasing…';
        fetch('/api/cc/ivr/release-held', { method: 'POST' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not release'); return j; }); })
          .then(function (j) { m.textContent = num(j.released) + ' leads are back with the callers.'; rb.disabled = false; setTimeout(loadIvr, 1500); }).catch(function (e) { m.textContent = e.message; rb.disabled = false; });
      };
      var pb = $('cp-pause'); if (pb) pb.onclick = function () {
        var want = !(v.stats && v.stats.paused);
        if (!confirm(want ? 'Pause all real IVR calls now?' : 'Resume real IVR calls?')) return;
        pb.disabled = true;
        fetch('/api/cc/ivr/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: want }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not change it'); return j; }); })
          .then(function () { loadIvr(); }).catch(function (e) { $('cp-pmsg').textContent = e.message; pb.disabled = false; });
      };
    }).catch(function (e) { box.innerHTML = '<div class="cp-err">' + esc(e.message) + '</div>'; });
  }

  // IVR test calls: only to the owner's own numbers set in Railway (IVR_TEST_NUMBERS). Never touches a real order.
  function loadIvrTools() {
    var el = $('cp-ivrtools'); if (!el) return;
    fetch('/api/cc/ivr/status').then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not load the IVR set-up'); return j; }); }).then(function (v) {
      var su = v.setup, WHAT = { confirmed: 'Confirmed (1)', address_change: 'Change address (2)', cancel_requested: 'Cancel (3)', unknown: 'Other key' };
      var h = '<h3>IVR test calls</h3><div class="cp-sub">A test call rings one of your own numbers with a sample order. It never touches a real order. Press 1, 2 or 3 on the call and the result should appear below within a minute.</div>';
      if (su.missing.length) h += '<div class="cp-box"><span><b>Not ready.</b> Still to set in Railway (web service): ' + su.missing.map(esc).join(', ') + '.</span></div>';
      else h += '<div class="cp-box"><span>Template <b>' + esc(su.template) + '</b> · flow <b>' + esc(su.flow_id) + '</b> · test numbers: ' + su.test_numbers.map(esc).join(', ') + '</span>' +
        '<select id="cp-tslot" style="padding:9px 10px;border:1px solid var(--ds-border-strong);border-radius:8px;background:var(--ds-surface);color:var(--ds-text)">' + su.test_numbers.map(function (n, i) { return '<option value="' + i + '">' + esc(n) + '</option>'; }).join('') + '</select>' +
        '<button class="cp-btn main" id="cp-tcall">Send a test call</button></div><div class="cp-msg" id="cp-tmsg"></div>';
      var KIND = { fresh: 'New order', first: 'First call (older lead)', retry: 'Retry', backlog: 'Old no-answer' };
      var stText = function (r) { if (r.status === 'skipped') return 'Left to a person'; if (r.status === 'failed' || r.status === 'failed_system') return 'Request failed'; if (r.result) return '<b>Answered</b>'; if (r.status === 'placed') return (Date.now() - new Date(r.placed_at).getTime()) / 60000 <= 15 ? 'Calling… waiting for a key' : 'No key pressed'; return esc(r.status); };
      h += '<h3>Latest IVR calls</h3><div class="cp-sub">The last ' + v.recent.length + ' calls, newest first. "No key pressed" means the customer did not answer or hung up before pressing a key.</div>' + (v.recent.length ? '<div style="max-height:460px;overflow:auto"><table class="cp-tbl"><tr><th>When</th><th>Order</th><th>Number</th><th>Kind</th><th>Try</th><th>Status</th><th>Key pressed</th><th>Note</th></tr>' + v.recent.map(function (r) {
        return '<tr><td>' + esc(new Date(r.placed_at).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</td><td>' + esc(r.order_name || '') + '</td><td>' + esc(r.phone) + '</td><td>' + (r.is_test ? 'Test' : esc(KIND[r.kind] || 'Order')) + '</td><td>' + (r.is_test ? '' : num(r.attempt)) + '</td><td>' + stText(r) + '</td><td>' + esc(r.result ? (WHAT[r.result] || r.result) : '') + '</td><td style="text-align:left">' + esc(r.status === 'skipped' || r.status === 'failed' ? (r.note || '') : '') + '</td></tr>'; }).join('') + '</table></div>' : '<div class="cp-sub">No IVR calls yet.</div>');
      h += '<h3>Key presses received</h3><div class="cp-sub">Every key press the IVR sends to the CRM. "Fields sent" are the names of the details that came with it, which show how a press is matched to a call.' + (v.forward_set ? ' Presses for calls the CRM did not place are passed on to the old receiver.' : '') + '</div>' +
        (v.presses && v.presses.length ? '<table class="cp-tbl"><tr><th>When</th><th>Key</th><th>What happened</th><th>Fields sent</th></tr>' + v.presses.map(function (r) {
          return '<tr><td>' + esc(new Date(r.at).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</td><td>' + esc(r.key) + '</td><td style="text-align:left">' + esc(r.outcome) + '</td><td style="text-align:left">' + esc((r.fields || []).join(', ') || 'none') + '</td></tr>'; }).join('') + '</table>' : '<div class="cp-sub">None yet.</div>');
      el.innerHTML = h;
      var b = $('cp-tcall'); if (b) b.onclick = function () {
        var m = $('cp-tmsg'), slot = Number($('cp-tslot').value);
        if (!confirm('Ring ' + su.test_numbers[slot] + ' now with a test call?')) return;
        b.disabled = true; m.textContent = 'Calling…';
        fetch('/api/cc/ivr/test-call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: slot }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'The call was not accepted'); return j; }); })
          .then(function (j) { m.textContent = 'Call placed: ' + j.message + '. Pick up and press 1, 2 or 3.'; b.disabled = false; setTimeout(loadIvrTools, 20000); })
          .catch(function (e) { m.textContent = e.message; b.disabled = false; });
      };
    }).catch(function (e) { el.innerHTML = '<div class="cp-err">' + esc(e.message) + '</div>'; });
  }

  function split() {
    var a = parseInt($('cp-s-aman').value, 10) || 0, c = parseInt($('cp-s-cc').value, 10) || 0, m = $('cp-smsg');
    if (!a && !c) { m.textContent = 'Enter how many leads to move.'; return; }
    if (!confirm('Move ' + (a ? a + ' old leads from the Call centre to Aman' : '') + (a && c ? ' and ' : '') + (c ? c + ' old leads from Aman to the Call centre' : '') + '? Each move is written to the order history.')) return;
    var b = $('cp-split'); b.disabled = true; m.textContent = 'Moving…';
    fetch('/api/cc/load-plan/split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aman: a, cc: c }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not move the leads'); return j; }); })
      .then(function (j) { m.textContent = j.moved + ' leads moved' + (j.planned > j.moved ? ' (' + (j.planned - j.moved) + ' had changed meanwhile and stayed)' : '') + (a > j.cc_to_aman || c > j.aman_to_cc ? '. Fewer old leads were available than you asked for.' : '.'); setTimeout(load, 1500); })
      .catch(function (e) { m.textContent = e.message; b.disabled = false; });
  }
  function s_h(n) { var h = Math.floor(n), m = Math.round((n - h) * 60); return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h >= 12 ? ' pm' : ' am'); }

  function apply() {
    if (!confirm('Move the planned leads between the teams now? Each move is written to the order history.')) return;
    var b = $('cp-apply'); b.disabled = true; $('cp-msg').textContent = 'Moving…';
    fetch('/api/cc/load-plan/apply', { method: 'POST' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not move the leads'); return j; }); })
      .then(function (j) { $('cp-msg').textContent = j.moved + ' leads moved' + (j.planned > j.moved ? ' (' + (j.planned - j.moved) + ' had changed meanwhile and stayed)' : '') + '.'; setTimeout(load, 1200); })
      .catch(function (e) { $('cp-msg').textContent = e.message; b.disabled = false; });
  }

  function load() {
    $('cp-body').innerHTML = '<div class="cp-load">Loading…</div>';
    fetch('/api/cc/load-plan').then(function (res) {
      if (res.status === 401) { location.href = '/login.html?next=/admin.html'; throw new Error('login'); }
      return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not load the call plan'); return j; });
    }).then(render).catch(function (e) { if (e.message !== 'login') $('cp-body').innerHTML = '<div class="cp-err">' + esc(e.message) + '</div>'; });
  }
  setInterval(function () { var a = document.activeElement; if (!document.hidden && p.classList.contains('active') && !(a && /INPUT|SELECT/.test(a.tagName))) loadIvr(); }, 30000);   // live: the IVR numbers refresh by themselves
  p.innerHTML = '<div class="cp"><div class="cp-top"><div class="cp-title">Call plan</div><button class="cp-btn" id="cp-refresh">Refresh</button></div><div id="cp-body"></div></div>';
  $('cp-refresh').onclick = load;
  t.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active'); p.classList.add('active'); load();
  };
})();
