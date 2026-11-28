/* Repeat customers (owner 2026-11-27/28): Aman calls customers who bought before and have not bought again.
   Lives in the "Repeat customers" tab of the Aman page: three pills, Repeat calling, Orders to confirm (the older open repeat ORDERS, unchanged) and Repeat report.
   Data: /api/cc/repeat/queue, /api/cc/repeat/:id/call, /api/cc/repeat/:id/whatsapp, /api/cc/repeat/report (rules in lib/repeatQueue.js). */
(function () {
  var host = document.getElementById('tab-repeat'); if (!host) return;
  // The WhatsApp button opens the customer's chat with this text. Replace it with the approved wording; {name} becomes the customer's first name.
  var WA_TEXT = 'Hi {name}, this is Jaadu Diet. Thank you for your earlier order with us. Would you like to order again? Reply here and we will help you.';
  var Q = { filter: 'ready', data: null, view: 'call', range: 'today' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function get(u) { return fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Failed'); return j; }); }); }
  function post(u, b) { return fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Failed'); return j; }); }); }
  var MON = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' };
  function monLabel(m) { var p = String(m || '').split('-'); return (MON[p[1]] || p[1] || '?') + ' ' + (p[0] || ''); }
  function ago(t) { if (!t) return ''; var m = Math.round((Date.now() - new Date(t).getTime()) / 60000), a = Math.abs(m); var s = a < 60 ? a + ' min' : a < 1440 ? Math.round(a / 60) + ' h' : Math.round(a / 1440) + ' d'; return m >= 0 ? s + ' ago' : 'in ' + s; }
  function when(t) { return t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
  function istLocalInput(d) { var x = new Date(d.getTime() + 19800000); return x.toISOString().slice(0, 16); }

  var css = document.createElement('style');
  css.textContent = '.rp-pills{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}.rp-pills button,.rp-chips button{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:8px 14px;font:600 13px Inter,sans-serif;cursor:pointer}' +
    '.rp-pills button.on,.rp-chips button.on{background:var(--green);color:#fff;border-color:var(--green)}.rp-chips{display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap}.rp-chips b{margin-left:6px}' +
    '.rp-note{font-size:13px;color:var(--muted);margin:6px 0 12px}.rp-warn{background:var(--yellow-dim);color:var(--yellow);border-radius:8px;padding:8px 12px;font-size:13px;margin:0 0 10px;font-weight:600}' +
    '.rp-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:0 0 10px;display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,300px);gap:12px 18px;align-items:center}' +
    '.rp-sel{width:100%;border:1px solid var(--border);border-radius:10px;padding:12px 12px;background:var(--surface2);color:var(--text);font:600 14px Inter,sans-serif;cursor:pointer}.rp-sel:focus{outline:2px solid var(--green);outline-offset:1px}' +
    '.rp-card h4{margin:0 0 2px;font:700 15px Inter,sans-serif}.rp-ph a{font:700 18px Inter,sans-serif;color:var(--green);text-decoration:none}.rp-meta{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5}' +
    '.rp-tag{display:inline-block;border-radius:6px;padding:2px 8px;font:600 11px Inter,sans-serif;background:var(--purple-dim);color:var(--purple);margin-right:4px}.rp-tag.due{background:var(--yellow-dim);color:var(--yellow)}' +
    '.rp-btns{display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start}.rp-btns button{border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:8px;padding:8px 10px;font:600 12px Inter,sans-serif;cursor:pointer}' +
    '.rp-btns button.go{background:var(--green);color:#fff;border-color:var(--green)}.rp-btns button.wa{background:#25d366;color:#04371a;border-color:#25d366}.rp-btns button.bad{color:var(--red)}' +
    '.rp-last{grid-column:1/-1;font-size:12px;color:var(--muted);white-space:pre-line;border-top:1px dashed var(--border);padding-top:8px}' +
    '.rp-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:200}.rp-box{background:var(--surface);border-radius:14px;padding:18px;width:min(420px,92vw)}' +
    '.rp-box h3{margin:0 0 10px;font:700 16px Inter,sans-serif}.rp-box label{display:block;font:600 12px Inter,sans-serif;margin:10px 0 4px;color:var(--muted)}.rp-box input,.rp-box textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:9px;background:var(--surface2);color:var(--text);font:14px Inter,sans-serif}' +
    '.rp-box .row{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}.rp-box .row button{border:1px solid var(--border);border-radius:8px;padding:9px 14px;font:700 13px Inter,sans-serif;cursor:pointer;background:var(--surface2);color:var(--text)}.rp-box .row .go{background:var(--green);color:#fff;border-color:var(--green)}' +
    '.rp-tbl{width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px}.rp-tbl th,.rp-tbl td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:right}.rp-tbl th:first-child,.rp-tbl td:first-child{text-align:left}.rp-tbl tr.tot td{font-weight:700}' +
    '.rp-h{font:700 15px Inter,sans-serif;margin:14px 0 6px}@media(max-width:720px){.rp-card{grid-template-columns:1fr}}';
  document.head.appendChild(css);

  // Wrap the older table (open repeat ORDERS to confirm) so it stays exactly as it was, and add the new views around it.
  var old = document.createElement('div'); old.id = 'rpOld'; old.style.display = 'none';
  while (host.firstChild) old.appendChild(host.firstChild);
  var pills = document.createElement('div'); pills.className = 'rp-pills';
  // The older open repeat ORDERS to confirm are no longer on this page: they are called from Leads to call (server.js adds them to that list). The wrapped table stays hidden; its counter element is kept so the old loader has somewhere to write.
  pills.innerHTML = '<button data-v="call" class="on">Repeat calling <b id="rpReadyN"></b></button><button data-v="rep">Repeat report</button><span id="rpOldN" style="display:none"></span>';
  var call = document.createElement('div'), rep = document.createElement('div'); rep.style.display = 'none';
  host.appendChild(pills); host.appendChild(call); host.appendChild(old); host.appendChild(rep);
  pills.addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (!b) return; Q.view = b.getAttribute('data-v'); show(); });
  function show() {
    pills.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === Q.view); });
    call.style.display = Q.view === 'call' ? '' : 'none'; old.style.display = Q.view === 'old' ? '' : 'none'; rep.style.display = Q.view === 'rep' ? '' : 'none';
    if (Q.view === 'rep') loadReport();
  }

  var CHIPS = [['ready', 'Ready now'], ['callbacks', 'Callbacks due'], ['fresh', 'Fresh'], ['retry', 'Not connected, retry due'], ['notdue', 'Not yet due'], ['all', 'All']];
  function whyTag(l) {
    var s = (l.status || '').replace('_', ' ');
    if (l.why === 'followup') return '<span class="rp-tag due">' + esc(s) + ' follow-up due ' + esc(ago(l.next_due_at)) + '</span>';
    if (l.why === 'retry') return '<span class="rp-tag due">retry due ' + esc(ago(l.next_due_at)) + ' (' + esc(s) + ')</span>';
    if (l.why === 'followup_later' || l.why === 'retry_later') return '<span class="rp-tag">' + esc(s) + ', next ' + esc(when(l.next_due_at)) + '</span>';
    return '<span class="rp-tag">fresh</span>';
  }
  // One dropdown per customer holds every result and the WhatsApp message. Choosing a result opens a small form (note, time, order number where needed).
  var SHORT = { interested: 'Interested', p2p: 'P2P (promise to pay)', wfc: 'WFC (waiting for confirmation)', call_back: 'Call back', not_interested: 'Not interested', sale_done: 'Sale done', dnp: 'DNP (did not pick up)', sw_off: 'Switched off', not_reachable: 'Not reachable' };
  var GROUPS = [['Follow up', ['interested', 'p2p', 'wfc', 'call_back']], ['Closed', ['not_interested', 'sale_done']], ['Not reached', ['dnp', 'sw_off', 'not_reachable']]];
  function selectHtml(disp) {
    var have = {}; disp.forEach(function (d) { have[d.key] = d; });
    var o = '<option value="" selected disabled>Call result…</option>' + GROUPS.map(function (g) {
      return '<optgroup label="' + g[0] + '">' + g[1].filter(function (k) { return have[k]; }).map(function (k) { return '<option value="' + k + '">' + esc(SHORT[k] || have[k].label) + '</option>'; }).join('') + '</optgroup>';
    }).join('') + '<optgroup label="Message"><option value="wa">WhatsApp the customer</option></optgroup>';
    return '<select class="rp-sel" aria-label="Call result">' + o + '</select>';
  }
  function card(l, disp) {
    var first = String(l.name || '').trim().split(/\s+/)[0] || 'there';
    return '<div class="rp-card" data-id="' + l.id + '" data-name="' + esc(first) + '" data-phone="' + esc(l.phone10) + '"><div class="rp-main"><h4>' + esc(l.name || 'Customer') + '</h4><div class="rp-ph"><a href="tel:' + esc(l.phone10) + '">' + esc(l.phone10) + '</a></div>' +
      '<div class="rp-meta">' + whyTag(l) + '<span class="rp-tag">' + esc(monLabel(l.acq_month)) + '</span><br>Bought ' + (l.delivered_orders || 1) + ' time(s) · last order ' + esc(l.last_order_date || '—') + '<br>Calls so far: ' + (l.attempts || 0) + (l.last_call_at ? ' · last ' + esc(ago(l.last_call_at)) : '') + '</div></div>' +
      '<div class="rp-act">' + selectHtml(disp) + '</div>' + (l.notes ? '<div class="rp-last">' + esc(String(l.notes).split('\n').slice(0, 3).join('\n')) + '</div>' : '') + '</div>';
  }
  function draw() {
    var d = Q.data; if (!d) return;
    var c = d.counts, chips = CHIPS.map(function (x) { return '<button type="button" data-f="' + x[0] + '" class="' + (Q.filter === x[0] ? 'on' : '') + '">' + x[1] + '<b>' + (c[x[0]] || 0) + '</b></button>'; }).join('');
    var w = d.mix && d.mix.weights ? Object.keys(d.mix.weights).sort().map(function (m) { return monLabel(m) + ' ' + d.mix.weights[m] + '%'; }).join(' · ') : '';
    var warn = d.blocked_fresh ? '<div class="rp-warn">' + (c.callbacks + c.retry) + ' follow-up(s) are due. Finish them first: ' + d.blocked_fresh + ' fresh lead(s) wait so no lead is wasted. The Fresh button still shows them.</div>' : '';
    var rows = d.rows.length ? d.rows.map(function (l) { return card(l, d.dispositions); }).join('') : '<div class="rp-note">Nothing in this view.</div>';
    var dy = d.daily || {}, today = '<b>' + (dy.used_today || 0) + '</b> first calls made today of <b>' + (dy.limit || 0) + '</b> fresh leads a day. ' + (dy.waiting_for_later_days ? '<b>' + dy.waiting_for_later_days.toLocaleString('en-IN') + '</b> more customers wait for later days (released day by day, never all at once). ' : '');
    var left = (dy.limit || 0) - (dy.used_today || 0) <= 0 && !c.callbacks && !c.retry ? '<div class="rp-warn">Today\'s fresh leads are all called. More are released tomorrow.</div>' : '';
    call.innerHTML = '<div class="rp-chips">' + chips + '</div>' + warn + left + '<div class="rp-note">' + today + 'Fresh leads follow the month mix (' + esc(w) + '). Showing ' + d.shown + ' of ' + d.total_in_view + ' in this view.</div>' + rows;
    var n = document.getElementById('rpReadyN'); if (n) n.textContent = c.ready || '';
    var cr = document.getElementById('countRepeat'); if (cr) cr.textContent = c.ready || 0;       // the number on the Repeat customers button
  }
  function load() { return get('/api/cc/repeat/queue?filter=' + Q.filter).then(function (d) { Q.data = d; draw(); }).catch(function (e) { call.innerHTML = '<div class="rp-warn">' + esc(e.message) + '</div>'; }); }
  call.addEventListener('click', function (e) {
    var f = e.target.closest('button[data-f]'); if (f) { Q.filter = f.getAttribute('data-f'); load(); return; }
  });
  call.addEventListener('change', function (e) {
    var sel = e.target.closest('select.rp-sel'), cardEl = e.target.closest('.rp-card'); if (!sel || !cardEl) return;
    var id = cardEl.getAttribute('data-id'), key = sel.value; sel.selectedIndex = 0;       // back to "Call result…" so the same result can be picked again
    if (key === 'wa') { sendWa(id, cardEl); return; }
    if (key) dialog(id, key, cardEl);
  });
  function sendWa(id, el) {
    var phone = el.getAttribute('data-phone'), text = WA_TEXT.replace('{name}', el.getAttribute('data-name'));
    window.open('https://wa.me/91' + phone + '?text=' + encodeURIComponent(text), '_blank');
    post('/api/cc/repeat/' + id + '/whatsapp', {}).catch(function () {});
  }
  function dialog(id, key, el) {
    var d = (Q.data.dispositions || []).filter(function (x) { return x.key === key; })[0]; if (!d) return;
    var m = document.createElement('div'); m.className = 'rp-modal';
    var def = key === 'call_back' ? istLocalInput(new Date(Date.now() + 3600e3)) : '';
    m.innerHTML = '<div class="rp-box"><h3>' + esc(d.label) + ' · ' + esc(el.getAttribute('data-name')) + '</h3>' +
      (d.needsOrder ? '<label>Order number (required)</label><input id="rpOrder" placeholder="#12345">' : '') +
      (d.needsTime ? '<label>Call back at (required)</label><input id="rpWhen" type="datetime-local" value="' + def + '">' : (d.followup ? '<label>Next follow-up (leave empty for the default)</label><input id="rpWhen" type="datetime-local">' : '')) +
      '<label>Note</label><textarea id="rpNote" rows="3" placeholder="What the customer said"></textarea><div class="row"><button type="button" id="rpNo">Cancel</button><button type="button" class="go" id="rpYes">Save</button></div><div class="rp-warn" id="rpErr" style="display:none;margin-top:10px"></div></div>';
    document.body.appendChild(m);
    m.querySelector('#rpNo').onclick = function () { m.remove(); };
    m.querySelector('#rpYes').onclick = function () {
      var w = m.querySelector('#rpWhen'), body = { disposition: key, notes: m.querySelector('#rpNote').value, order_no: m.querySelector('#rpOrder') ? m.querySelector('#rpOrder').value : '' };
      if (w && w.value) body.callback_at = new Date(w.value + ':00+05:30').toISOString();
      post('/api/cc/repeat/' + id + '/call', body).then(function () { m.remove(); load(); }).catch(function (e) { var er = m.querySelector('#rpErr'); er.textContent = e.message; er.style.display = ''; });
    };
  }

  // ---- report
  var RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['3d', 'Last 3 days'], ['7d', 'Last 7 days'], ['month', 'This month']];
  function dayStr(offset) { return new Date(Date.now() + 19800000 - offset * 86400000).toISOString().slice(0, 10); }
  function rangeDates() { var t = dayStr(0); return Q.range === 'today' ? [t, t] : Q.range === 'yesterday' ? [dayStr(1), dayStr(1)] : Q.range === '3d' ? [dayStr(2), t] : Q.range === '7d' ? [dayStr(6), t] : [t.slice(0, 8) + '01', t]; }
  function loadReport() {
    var r = rangeDates();
    get('/api/cc/repeat/report?from=' + r[0] + '&to=' + r[1]).then(function (R) { drawReport(R); }).catch(function (e) { rep.innerHTML = '<div class="rp-warn">' + esc(e.message) + '</div>'; });
  }
  function pct(v) { return v == null ? '—' : v + '%'; }
  function drawReport(R) {
    var btns = RANGES.map(function (x) { return '<button type="button" data-r="' + x[0] + '" class="' + (Q.range === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('');
    var head = ['Day', 'Calls', 'Connected', 'Connectivity', 'Interested', 'P2P', 'WFC', 'Call back', 'Not interested', 'Sales claimed', 'Sales verified', 'DNP', 'Switched off', 'Not reachable'];
    var line = function (x, label, cls) { return '<tr class="' + (cls || '') + '"><td>' + label + '</td><td>' + x.calls + '</td><td>' + x.connected + '</td><td>' + pct(x.connectivity_pct) + '</td><td>' + x.interested + '</td><td>' + x.p2p + '</td><td>' + x.wfc + '</td><td>' + x.call_back + '</td><td>' + x.not_interested + '</td><td>' + x.sales_claimed + '</td><td>' + (x.sales_verified == null ? '—' : x.sales_verified) + '</td><td>' + x.dnp + '</td><td>' + x.sw_off + '</td><td>' + x.not_reachable + '</td></tr>'; };
    var days = R.days.map(function (d) { return line(d, esc(d.day)); }).join('') + (R.days.length > 1 ? line(R.totals, 'All these days', 'tot') : '');
    var pool = R.pool.map(function (p) { return '<tr><td>' + esc(monLabel(p.acq_month)) + '</td><td>' + p.customers + '</td><td>' + p.never_called + '</td><td>' + p.closed + '</td><td>' + p.sales + '</td></tr>'; }).join('');
    var q = R.queue || {};
    rep.innerHTML = '<div class="rp-chips">' + btns + '</div><div class="rp-note">Connected means the customer spoke to Aman (interested, P2P, WFC, call back, not interested or sale). Connectivity = connected calls ÷ all calls. Sales verified = the customer\'s phone has a real order in the CRM after the sale call.</div>' +
      '<table class="rp-tbl"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + (days || '<tr><td colspan="14">No calls in these dates.</td></tr>') + '</tbody></table>' +
      '<div class="rp-h">Follow-ups and leads right now</div><table class="rp-tbl"><tbody><tr><td>Follow-ups due now</td><td>' + (q.callbacks || 0) + '</td></tr><tr><td>Follow-ups overdue more than 24 hours</td><td>' + (R.followups_overdue_24h || 0) + '</td></tr><tr><td>Retries due (DNP, switched off, not reachable)</td><td>' + (q.retry || 0) + '</td></tr><tr><td>Fresh leads released today and not yet called (daily limit ' + ((R.daily || {}).limit || 0) + ', first calls made today ' + ((R.daily || {}).used_today || 0) + ')</td><td>' + (q.fresh || 0) + '</td></tr><tr><td>Fresh customers waiting for later days</td><td>' + ((R.daily || {}).waiting_for_later_days || 0) + '</td></tr></tbody></table>' +
      '<div class="rp-h">The customer pool by month of first purchase</div><table class="rp-tbl"><thead><tr><th>Month</th><th>Customers</th><th>Never called</th><th>Closed</th><th>Sales</th></tr></thead><tbody>' + pool + '</tbody></table>';
  }
  rep.addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b) return; Q.range = b.getAttribute('data-r'); loadReport(); });

  load(); setInterval(function () { if (!document.hidden && Q.view === 'call' && !document.querySelector('.rp-modal')) load(); }, 60000);
})();
