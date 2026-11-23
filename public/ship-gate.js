/* Admin "Ship gate" tab (phase 1, read-only). Which orders are safe to ship, which are held and why, what must ship today,
   what shipped that should not have, and the admin's holiday list. Uses helpers from admin.html ($, esc, fmt, api, table, today). */
(function () {
  var tabsEl = $('tabs'), anchor = $('p-log'), VIEW = 'ready', DATA = null;
  var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = 'shipgate'; t.textContent = 'Ship gate';
  tabsEl.insertBefore(t, tabsEl.children[1] || null);
  var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-shipgate';
  p.innerHTML =
    '<div id="sg-health"></div><div class="msg" id="sg-today"></div><div class="cards" id="sg-cards"></div>' +
    '<div class="filters" id="sg-views"></div>' +
    '<div class="filters" id="sg-tools"></div><div id="sg-msg"></div>' +
    '<div class="tw"><table id="sg-table"></table></div>' +
    '<div id="sg-hol" style="display:none"><div class="filters"><div><label>Date</label><input type="date" id="sg-hd"></div>' +
    '<div><label>Note</label><input id="sg-hn" placeholder="e.g. Diwali" style="width:200px"></div>' +
    '<button class="btn" id="sg-hadd">Add holiday</button><button class="btn alt" id="sg-htoday">Mark today as a holiday</button></div>' +
    '<div class="muted">Sundays are never shipping days and are added automatically. A holiday keeps every order from being due on that day.</div>' +
    '<div class="tw"><table id="sg-htable"></table></div></div>';
  anchor.parentNode.appendChild(p);
  t.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active'); p.classList.add('active'); load();
  };

  var VIEWS = [['ready', 'Ready to ship'], ['chase', 'Chase today'], ['blocked', 'Blocked'], ['wrong', 'Wrong ships'], ['accuracy', 'Accuracy'], ['holidays', 'Holidays']];
  var money = function (n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); };
  var fail = function (e) { if (e && e.message !== 'login' && e.message !== 'forbidden') alert(e.message); };
  var card = function (v, l, cls) { return '<div class="card"><div class="v ' + (cls || '') + '">' + v + '</div><div class="l">' + l + '</div></div>'; };
  var msg = function (html, cls) { $('sg-msg').innerHTML = html ? '<div class="msg ' + (cls || '') + '">' + html + '</div>' : ''; };
  var dayLabel = function (k) { return k ? new Date(k + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }) : '—'; };
  var status = function (r) {
    if (r.ship_status === 'overdue') return '<span class="bad"><b>Overdue</b></span>';
    if (r.ship_status === 'due_today') return '<span style="color:var(--ds-warn-ink)"><b>Due today</b></span>';
    return 'Ship by ' + esc(dayLabel(r.due));
  };
  var COLS = {
    ready: [['Order', function (r) { return r.order_name; }], ['Customer', function (r) { return r.customer_name; }], ['Address', function (r) { return r.address; }, 1], ['City', function (r) { return r.city; }], ['Pincode', function (r) { return r.zip; }],
      ['Product', function (r) { return r.product; }, 1], ['Payment', function (r) { return r.payment; }], ['Collect', function (r) { return money(r.collect); }], ['Ready since', function (r) { return fmt(r.ready_at); }], ['Status', status, 0, 1], ['Team', function (r) { return r.team || '—'; }]],
    blocked: [['Order', function (r) { return r.order_name; }], ['Customer', function (r) { return r.customer_name; }], ['Phone', function (r) { return r.customer_phone; }], ['Payment', function (r) { return r.payment; }],
      ['Amount', function (r) { return money(r.total_price); }], ['Why it is held', function (r) { return r.reason_text.join(', '); }, 1], ['Team', function (r) { return r.team || '—'; }]],
    wrong: [['Order', function (r) { return r.order_name; }], ['Customer', function (r) { return r.customer_name; }], ['AWB', function (r) { return r.awb || '—'; }], ['Courier', function (r) { return r.courier || '—'; }],
      ['Payment', function (r) { return r.payment; }], ['Amount', function (r) { return money(r.total_price); }], ['Should not have shipped because', function (r) { return r.reason_text.join(', '); }, 1]],
  };
  COLS.chase = COLS.ready;
  var EMPTY = { ready: 'Nothing is waiting to ship.', chase: 'Nothing is due today or late.', blocked: 'No order is being held.', wrong: 'No wrong shipment found.' };

  function viewBar() {
    $('sg-views').innerHTML = VIEWS.map(function (v) {
      var n = DATA && DATA.counts && DATA.counts[v[0]] !== undefined ? ' (' + DATA.counts[v[0]] + ')' : '';
      return '<button class="btn' + (v[0] === VIEW ? '' : ' alt') + '" data-v="' + v[0] + '">' + esc(v[1]) + n + '</button>';
    }).join('');
    $('sg-views').querySelectorAll('button').forEach(function (b) { b.onclick = function () { VIEW = b.dataset.v; render(); }; });
  }

  function render() {
    if (!DATA) return;
    var h = DATA.health;
    $('sg-health').innerHTML = h.ok
      ? '<div class="msg ok">Data feeds look healthy. Last courier update ' + (h.hours_since_courier_update === null ? '—' : h.hours_since_courier_update + ' h ago') + ', last order ' + (h.hours_since_order === null ? '—' : h.hours_since_order + ' h ago') + '.</div>'
      : '<div class="msg bad"><b>Check the data feeds.</b><br>' + h.issues.map(esc).join('<br>') + '</div>';
    $('sg-today').innerHTML = (DATA.shipping_day ? 'Today (' + esc(dayLabel(DATA.today)) + ') is a shipping day.' : 'Today (' + esc(dayLabel(DATA.today)) + ') is <b>not</b> a shipping day (Sunday or holiday). Next shipping day: ' + esc(dayLabel(DATA.next_shipping_day)) + '.') +
      ' <span class="muted">Shadow mode: this tab only shows lists. It does not block or change any order.</span>' +
      (DATA.track_from ? '<br><span class="muted">Orders that were ready before ' + esc(fmt(DATA.track_from)) + ' are not counted as ready or late: the CRM did not receive courier updates then, so it cannot tell if they shipped. They appear under "Before tracking began".</span>' : '');
    var c = DATA.counts;
    $('sg-cards').innerHTML = card(c.ready, 'Ready to ship') + card(c.chase, 'Due today or late', c.chase ? 'bad' : '') + card(c.blocked, 'Held back') + card(c.wrong, 'Wrong ships', c.wrong ? 'bad' : 'ok') + card(c.untracked || 0, 'Before tracking began');
    viewBar();
    msg('');
    $('sg-hol').style.display = VIEW === 'holidays' ? '' : 'none';
    $('sg-table').parentNode.style.display = VIEW === 'holidays' ? 'none' : '';
    var tools = '';
    if (VIEW === 'ready' || VIEW === 'chase') tools += '<button class="btn" id="sg-copy">Copy order numbers</button>';
    if (['ready', 'chase', 'blocked', 'wrong'].indexOf(VIEW) >= 0) tools += '<a class="btn alt" id="sg-csv" href="#">Download CSV</a>';
    $('sg-tools').innerHTML = tools; $('sg-tools').style.display = tools ? '' : 'none';
    if ($('sg-copy')) $('sg-copy').onclick = copyNumbers;
    if ($('sg-csv')) $('sg-csv').onclick = function (e) { e.preventDefault(); location.href = '/api/admin/ship-gate/export?list=' + VIEW; };
    if (VIEW === 'holidays') return loadHolidays().catch(fail);
    if (VIEW === 'accuracy') {
      table('sg-table', [['Ship-by day', function (r) { return dayLabel(r.day); }], ['Orders due', function (r) { return r.due; }], ['Shipped on time', function (r) { return '<span class="ok">' + r.on_time + '</span>'; }, 0, 1],
        ['Shipped late', function (r) { return r.late; }], ['Missed', function (r) { return r.missed ? '<span class="bad">' + r.missed + '</span>' : 0; }, 0, 1], ['Waiting', function (r) { return r.waiting; }], ['Shipped, time unknown', function (r) { return r.time_unknown; }]],
        DATA.accuracy, 'No orders were due in the last 7 days.');
      msg(esc(DATA.note));
      return;
    }
    table('sg-table', COLS[VIEW], DATA[VIEW], EMPTY[VIEW]);
  }

  function copyNumbers() {
    var text = DATA[VIEW].map(function (o) { return o.order_name; }).join('\n');
    var done = function () { msg('Copied ' + DATA[VIEW].length + ' order numbers. Paste them in the Shiprocket search to select these orders.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { msg('Could not copy. Use Download CSV instead.', 'bad'); });
    else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { msg('Could not copy. Use Download CSV instead.', 'bad'); } document.body.removeChild(ta); }
  }

  async function loadHolidays() {
    var d = await api('/api/admin/ship-gate/holidays');
    if (!d.available) { msg('The holiday list is not set up yet. Ask your developer to run <code>node migrate.js --apply</code> in the Railway Console. Until then Sundays are still respected.', 'bad'); table('sg-htable', [], [], ''); return; }
    table('sg-htable', [['Date', function (r) { return dayLabel(r.date); }], ['Note', function (r) { return r.note || '—'; }], ['Added by', function (r) { return r.created_by || '—'; }],
      ['', function (r) { return '<button class="btn alt" data-d="' + esc(r.date) + '">Remove</button>'; }, 0, 1]], d.rows, 'No holidays added yet.');
    $('sg-htable').querySelectorAll('button[data-d]').forEach(function (b) {
      b.onclick = async function () { if (!confirm('Remove this holiday?')) return; try { await api('/api/admin/ship-gate/holidays/remove', { date: b.dataset.d }); await refresh(); } catch (e) { fail(e); } };
    });
  }
  async function addHoliday(date, note) {
    try { await api('/api/admin/ship-gate/holidays', { date: date, note: note }); $('sg-hn').value = ''; await refresh(); msg('Holiday saved.', 'ok'); } catch (e) { fail(e); }
  }
  $('sg-hadd').onclick = function () { addHoliday($('sg-hd').value, $('sg-hn').value); };
  $('sg-htoday').onclick = function () { addHoliday(today(), $('sg-hn').value || 'Holiday'); };

  async function load() { $('sg-cards').innerHTML = '<div class="msg"><span class="spin"></span> Loading…</div>'; try { DATA = await api('/api/admin/ship-gate'); render(); } catch (e) { fail(e); } }
  async function refresh() { DATA = await api('/api/admin/ship-gate'); render(); }
})();
