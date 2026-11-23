/* Confirmations by channel (Aman, call centre, IVR, WhatsApp). Data: /api/cc/channels. Uses the .fu styles from funnel-ui.js.
   ChannelUI.mount(el, { view: 'aman' | 'cc' | 'all', title }) */
(function () {
  var TZ = 'Asia/Kolkata';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 + '%' : '—'; }
  var DASH = '<span style="color:var(--ds-faint)" title="Not stored in the CRM">—</span>';

  function mount(el, opt) {
    opt = opt || {};
    var S = { period: 'last7', data: null };
    el.classList.add('fu');
    el.innerHTML = '<div class="fu-top"><div class="fu-title">' + esc(opt.title || 'Confirmations by channel') + '<small id="chSub"></small></div>' +
      '<div><label>Period</label><select data-c="period"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option>' +
      '<option value="last10">Last 10 days</option><option value="last30">Last 30 days</option><option value="custom">Custom dates…</option></select></div>' +
      '<span data-c="customBox" style="display:none"><div style="display:flex;gap:6px;align-items:flex-end"><div><label>From</label><input type="date" data-c="from"></div><div><label>To</label><input type="date" data-c="to"></div></div></span>' +
      '<button class="fu-btn go" data-c="go">Apply</button><button class="fu-btn dl" data-c="csv">Download CSV</button></div><div id="chBody"><div class="fu-load">Loading…</div></div>';
    el.querySelector('[data-c="period"]').value = S.period;

    function range() {
      var t = today();
      switch (S.period) {
        case 'today': return { from: t, to: t };
        case 'yesterday': var y = addDays(t, -1); return { from: y, to: y };
        case 'last3': return { from: addDays(t, -2), to: t };
        case 'last10': return { from: addDays(t, -9), to: t };
        case 'last30': return { from: addDays(t, -29), to: t };
        case 'custom': return { from: el.querySelector('[data-c="from"]').value || t, to: el.querySelector('[data-c="to"]').value || t };
        default: return { from: addDays(t, -6), to: t };
      }
    }

    function rows(d) {
      var c = d.channels, v = d.view, out = [];
      function team(name, x) { return { name: name, calls: x.calls, spoke: x.connected, confirmed: x.confirmed, cancelled: x.cancelled, address: x.address_fix, noanswer: x.dnp }; }
      if (v === 'aman' || v === 'all') out.push(team('Aman (calls)', c.aman));
      if (v === 'cc' || v === 'all') out.push(team('Call centre (calls)', c.cc));
      if (v === 'all' && c.admin.calls) out.push(team('Admin (calls)', c.admin));
      if (v === 'all') {
        out.push({ name: 'IVR (results)', calls: c.ivr.results, spoke: c.ivr.answered, confirmed: c.ivr.confirmed, cancelled: c.ivr.cancelled, address: null, noanswer: c.ivr.no_answer });
        out.push({ name: 'WhatsApp (customer replies)', calls: c.whatsapp.replies, spoke: c.whatsapp.replies, confirmed: c.whatsapp.confirmed, cancelled: c.whatsapp.cancelled, address: null, noanswer: null });
        var oc = c.sheet.confirmed + c.other.confirmed, ox = c.sheet.cancelled + c.other.cancelled;
        if (oc || ox) out.push({ name: 'Other (sheet / auto-cancel / payment)', calls: null, spoke: null, confirmed: oc, cancelled: ox, address: null, noanswer: null, plain: true });
        out.push({ name: 'Total', calls: null, spoke: null, confirmed: c.total.confirmed, cancelled: c.total.cancelled, address: null, noanswer: null, total: true });
      }
      return out;
    }

    function render(d) {
      S.data = d;
      el.querySelector('#chSub').textContent = d.from + (d.from === d.to ? '' : ' to ' + d.to) + ' · COD orders · counted on the day the call / reply happened';
      var cell = function (v) { return v === null || v === undefined ? DASH : v; };
      var r = rows(d);
      var table = '<div class="fu-tw"><table><thead><tr><th>Channel</th><th title="Calls made by the team, or results / replies for IVR and WhatsApp">Calls / replies</th><th title="Customer spoke / answered">Spoke</th><th>Confirmed</th><th>Cancelled</th><th>Confirmed % of spoke</th><th>Address fixed</th><th>No answer</th></tr></thead><tbody>' +
        r.map(function (x) {
          return '<tr' + (x.total ? ' class="tot"' : '') + '><td>' + esc(x.name) + '</td><td>' + cell(x.calls) + '</td><td>' + cell(x.spoke) + '</td><td><b>' + x.confirmed + '</b></td><td>' + x.cancelled + '</td><td>' +
            (x.spoke === null ? DASH : pct(x.confirmed, x.spoke)) + '</td><td>' + cell(x.address) + '</td><td>' + cell(x.noanswer) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      var note = d.view === 'all'
        ? '<div class="fu-note">IVR calls placed and WhatsApp messages sent are not stored in the CRM, only what the customer answered. Address changes made on WhatsApp are not stored either (shown as —).</div>' : '';
      var people = d.people.length ? '<h3>By person</h3><div class="fu-tw"><table><thead><tr><th>Person</th><th>Team</th><th>Calls</th><th>Spoke</th><th>Confirmed</th><th>Cancelled</th><th>Address fixed</th></tr></thead><tbody>' +
        d.people.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td>' + (p.role === 'aman' ? 'Aman' : p.role === 'agent' ? 'Call centre' : 'Admin') + '</td><td>' + p.calls + '</td><td>' + p.connected + '</td><td><b>' + p.confirmed + '</b></td><td>' + p.cancelled + '</td><td>' + p.address_fix + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '';
      el.querySelector('#chBody').innerHTML = table + note + people;
    }

    function load() {
      var r = range();
      el.querySelector('#chBody').innerHTML = '<div class="fu-load">Loading…</div>';
      return fetch('/api/cc/channels?from=' + r.from + '&to=' + r.to + '&view=' + (opt.view || 'all')).then(function (res) {
        if (res.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || ('Error ' + res.status)); return j; });
      }).then(render).catch(function (e) { if (e.message !== 'login') el.querySelector('#chBody').innerHTML = '<div class="fu-warn">Could not load: ' + esc(e.message) + '</div>'; });
    }

    function csv() {
      if (!S.data) return;
      var lines = [['Channel', 'Calls or replies', 'Spoke', 'Confirmed', 'Cancelled', 'Address fixed', 'No answer']];
      rows(S.data).forEach(function (x) { lines.push([x.name, x.calls, x.spoke, x.confirmed, x.cancelled, x.address, x.noanswer].map(function (v) { return v === null || v === undefined ? '' : v; })); });
      var text = lines.map(function (l) { return l.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = 'channels_' + S.data.from + '_to_' + S.data.to + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    }

    el.addEventListener('change', function (e) {
      if (e.target.getAttribute('data-c') === 'period') {
        S.period = e.target.value; el.querySelector('[data-c="customBox"]').style.display = S.period === 'custom' ? '' : 'none';
        if (S.period !== 'custom') load();
      }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-c]'); if (!b) return;
      if (b.getAttribute('data-c') === 'go') load();
      if (b.getAttribute('data-c') === 'csv') csv();
    });
    load();
    return { refresh: load };
  }

  window.ChannelUI = { mount: mount };
})();
