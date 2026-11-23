/* Shared by aman-crm.html and cc-crm.html: date/status filters, date-aware stats,
   "All Orders" tab, CSV downloads, and the common call-outcome buttons + modal. */
(function () {
  var PAGE = location.pathname.indexOf('aman') > -1 ? 'aman' : 'cc';
  var SCOPE = PAGE === 'aman' ? 'inhouse' : 'cc';
  var META = null, CUR = null, ORDERS = {}, ROLE = null;
  var TZ = 'Asia/Kolkata';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00+05:30'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: TZ }); }
  function fmtDate(s) { return s ? new Date(s).toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '—'; }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') return window.showToast(msg, type || 'success');
    alert(msg);
  }
  async function api(path, body) {
    var opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    var r = await fetch(path, opt);
    if (r.status === 401) { location.href = '/login.html?next=' + location.pathname; throw new Error('login'); }
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(d.error || ('Error ' + r.status)); e.data = d; throw e; }
    return d;
  }

  // ---------------------------------------------------------------- address helpers
  function fullAddr(d) {
    return [d.shipping_address1, d.shipping_address2, d.shipping_city, d.shipping_province, d.shipping_zip]
      .map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean).join(', ');
  }
  function addrCell(d) {
    var txt = fullAddr(d) || '—';
    var badge = d.address_fixed ? ' <span class="xs confirmed">Address fixed</span>'
      : d.address_is_short ? ' <span class="xs dnc">Short address</span>' : '';
    return '<div class="xad" title="' + esc(txt) + '">' + esc(txt) + '</div>' + (badge ? '<div style="margin-top:4px">' + badge + '</div>' : '');
  }

  // ---------------------------------------------------------------- styles
  var css = '' +
    '.xbulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#4f46e5;color:#fff;border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:0.875rem}.xbulk .xq{background:#fff;color:#4338ca;border-color:#fff}' +
    '.xdr{position:fixed;inset:0;background:rgba(5,10,24,.6);z-index:350;display:none;justify-content:flex-end}.xdr.on{display:flex}' +
    '.xdr-in{width:min(520px,100%);height:100%;overflow:auto;background:var(--ds-surface);border-left:1px solid var(--ds-border);padding:18px 20px;color:var(--ds-text);position:relative}' +
    '.xdr-x{position:absolute;top:10px;right:14px;background:var(--ds-surface-2);border:1px solid var(--ds-border);color:var(--ds-text);border-radius:50%;width:30px;height:30px;cursor:pointer;font-size:1rem}' +
    '.xdr h3{font-size:1rem;margin:0 36px 6px 0}.xdr h4{font-size:0.75rem;text-transform:uppercase;letter-spacing:.7px;color:var(--ds-muted);margin:18px 0 10px}' +
    '.xdr-sub{font-size:0.875rem;color:var(--ds-muted);margin-bottom:6px}.xdr-addr{font-size:0.75rem;color:var(--ds-muted);margin-bottom:10px}.xdr-next{background:rgba(99,102,241,.14);border:1px solid var(--ds-brand);border-radius:10px;padding:9px 12px;font-size:0.875rem;font-weight:700;margin-bottom:10px}' +
    '.xdr-acts,.xdr-btns{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.xdr-acts a{text-decoration:none}.xdr-re{font-size:0.75rem;color:var(--ds-muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.xtls{list-style:none;padding:0;margin:0;border-left:2px solid var(--ds-border)}.xtl{position:relative;margin:0 0 11px 14px;padding:8px 10px;background:var(--ds-surface-2);border:1px solid var(--ds-border);border-radius:10px;font-size:0.75rem}' +
    '.xtl:before{content:"";position:absolute;left:-21px;top:12px;width:10px;height:10px;border-radius:50%;background:var(--ds-brand);border:2px solid var(--ds-surface)}.xtl.note:before{background:var(--ds-faint)}.xtl.event:before{background:var(--ds-info)}.xtl.link:before{background:var(--ds-brand)}' +
    '.xtl-t{font-size:0.75rem;color:var(--ds-muted);margin-top:2px}.xtl-n{margin-top:4px;color:var(--ds-muted)}' +
    '.xad{max-width:280px;white-space:normal;line-height:1.35;font-size:0.75rem;color:var(--ds-muted)}td.addr{min-width:230px;white-space:normal!important}' +
    '.xbal{margin:0 24px 14px;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:14px;padding:12px 16px;color:var(--ds-text);display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:0.75rem}' +
    '.xbal b{font-size:1rem}.xbal .xnote{flex-basis:100%;margin:0}.xbal.hot{border-color:var(--ds-brand)}' +
    '.xrq{display:none;gap:8px;align-items:center;flex-wrap:wrap}.xrq.on{display:flex}' +
    '.xp{margin:14px 24px;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:14px;padding:14px 16px;color:var(--ds-text);font-family:inherit}' +
    '.xp .row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}' +
    '.xp label{display:block;font-size:0.75rem;font-weight:700;color:var(--ds-faint);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}' +
    '.xp input,.xp select{background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:7px 10px;border-radius:9px;font-size:0.75rem;font-family:inherit;outline:none}' +
    '.xq{background:var(--ds-surface-2);color:var(--ds-text);border:1px solid var(--ds-border);padding:7px 12px;border-radius:9px;font-size:0.75rem;font-weight:600;cursor:pointer;font-family:inherit}' +
    '.xq:hover{border-color:var(--ds-brand)}.xq.on{border-color:var(--ds-brand);color:var(--ds-brand)}' +
    '.xdl{background:var(--ds-brand);color:#000;border:none;padding:8px 14px;border-radius:9px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit}' +
    '.xstats{display:flex;gap:10px;overflow-x:auto;margin-top:14px}' +
    '.xc{background:var(--ds-surface-2);border:1px solid var(--ds-border);border-radius:12px;padding:10px 16px;min-width:104px;text-align:center;flex-shrink:0}' +
    '.xc b{display:block;font-size:1.25rem;font-weight:800}.xc span{font-size:0.75rem;color:var(--ds-muted);text-transform:uppercase;letter-spacing:.6px;font-weight:600}' +
    '.xc.g b{color:var(--ds-brand)}.xc.r b{color:var(--ds-danger)}.xc.y b{color:var(--ds-warn-ink)}.xc.p b{color:var(--ds-brand)}.xc.c b{color:var(--ds-info)}' +
    '.xnote{font-size:0.75rem;color:var(--ds-muted);margin-top:8px}' +
    '.xbg{display:flex;gap:5px;flex-wrap:wrap;max-width:400px}' +
    '.xb{padding:6px 11px;border:none;border-radius:9px;cursor:pointer;font-size:0.75rem;font-weight:700;font-family:inherit}' +
    '.xb:hover{filter:brightness(1.12)}.xb:disabled{opacity:.4;cursor:not-allowed}' +
    '.xb.cf{background:var(--ds-brand);color:#000}.xb.cn{background:var(--ds-danger);color:#fff}.xb.dp{background:var(--ds-warn-ink);color:#000}' +
    '.xb.cb{background:var(--ds-brand);color:#fff}.xb.pl{background:var(--ds-info);color:#000}.xb.nt{background:var(--ds-surface-2);color:var(--ds-text);border:1px solid var(--ds-border)}' +
    '.xs{display:inline-block;padding:3px 9px;border-radius:8px;font-size:0.75rem;font-weight:700;background:var(--ds-surface-2);color:var(--ds-text)}' +
    '.xs.confirmed{background:rgba(16,185,129,.15);color:var(--ds-brand)}.xs.cancelled,.xs.wrong_number,.xs.dnc{background:rgba(239,68,68,.15);color:var(--ds-danger)}' +
    '.xs.callback{background:rgba(129,140,248,.18);color:var(--ds-brand)}.xs.dnp{background:rgba(245,158,11,.15);color:var(--ds-warn-ink)}' +
    '.xm-bg{display:none;position:fixed;inset:0;background:rgba(5,10,24,.8);z-index:400;align-items:center;justify-content:center}' +
    '.xm-bg.on{display:flex}' +
    '.xm{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:18px;width:92%;max-width:470px;max-height:92vh;overflow:auto;color:var(--ds-text);padding:20px 24px;font-family:inherit}' +
    '.xm h3{font-size:1rem;margin-bottom:10px}' +
    '.xm label{display:block;color:var(--ds-faint);font-size:0.75rem;font-weight:700;text-transform:uppercase;margin:12px 0 5px}' +
    '.xm textarea,.xm select,.xm input{width:100%;background:var(--ds-bg);border:1px solid var(--ds-border);color:var(--ds-text);padding:9px 12px;border-radius:10px;font-size:0.875rem;font-family:inherit;outline:none}' +
    '.xm textarea{min-height:76px;resize:vertical}' +
    '.xm .msg{padding:10px 14px;border-radius:10px;font-size:0.875rem;font-weight:600}' +
    '.xm .lk{word-break:break-all;background:var(--ds-bg);border:1px solid var(--ds-border);border-radius:10px;padding:10px 12px;font-size:0.875rem;color:var(--ds-info)}' +
    '.xm .ft{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}' +
    '@media(max-width:768px){.xp{margin:10px 12px}}';
  css += '.qchips{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 12px}.qchip{background:var(--ds-surface);border:1px solid var(--ds-border);color:var(--ds-muted);border-radius:999px;padding:7px 14px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit}' +
    '.qchip b{color:var(--ds-text);margin-left:6px}.qchip.on{background:#1a2d50;border-color:#3b6cb8;color:#cfe0ff}.qchip.hot b{color:var(--ds-warn-ink)}' +
    '.qwhy{font-size:0.75rem;margin-top:5px;color:var(--ds-muted);line-height:1.35;max-width:260px}.qwhy b{display:inline-block;border-radius:5px;padding:1px 7px;margin-right:5px;font-size:0.75rem;text-transform:uppercase;letter-spacing:.4px;background:var(--ds-border);color:#cfe0ff}' +
    '.qwhy.q-callback_due b{background:rgba(168,85,247,.25);color:#d8b4fe}.qwhy.q-fresh_overdue b{background:rgba(239,68,68,.22);color:var(--ds-danger)}.qwhy.q-fresh_new b{background:rgba(16,185,129,.22);color:var(--ds-brand)}.qwhy.q-retry b{background:rgba(245,158,11,.22);color:var(--ds-warn-ink)}' +
    '.qnext{display:inline-block;background:var(--ds-brand);color:#04170f;border-radius:5px;padding:1px 7px;margin-right:5px;font-size:0.75rem;font-weight:800;letter-spacing:.4px}tr.q-dim td{opacity:.5}tr.q-first td{background:rgba(16,185,129,.07)}';
  css += '.apbar{display:flex;gap:6px 18px;flex-wrap:wrap;align-items:center;margin:0 24px 10px;padding:9px 14px;border-radius:10px;border:1px solid var(--ds-border);background:var(--ds-surface);font-size:0.75rem;color:#c0cee0}' +
    '.apbar b{color:var(--ds-text)}.apbar .ok{color:var(--ds-brand)}.apbar .bad{color:var(--ds-danger)}.apbar .warn{color:var(--ds-warn-ink)}.apbar .tag{border-radius:5px;padding:2px 8px;font-size:0.75rem;background:var(--ds-border);color:var(--ds-muted)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------------------------------------------------------------- buttons (used by page tables)
  function buttons(d, opts) {
    opts = opts || {};
    var id = esc(d.id);
    var inhouse = d.assigned_to ? d.assigned_to === 'InHouse' : PAGE === 'aman';
    var p = d.dnp || {};
    var b = function (cls, act, label, extra) { return '<button class="xb ' + cls + '" ' + (extra || '') + ' onclick="CRMX.act(\'' + id + '\',\'' + act + '\')">' + label + '</button>'; };
    var h = '<div class="xbg">' +
      b('cf', 'confirmed', 'Confirm') + b('cn', 'cancelled', 'Cancel') +
      b('dp', 'dnp', 'DNP', p.atMax ? 'disabled title="Daily maximum reached"' : '') +
      b('cb', 'callback', 'Callback') +
      b(d.address_is_short && !d.address_fixed ? 'dp' : 'nt', 'address_fix', 'Fix address');
    if (!d.payment_method || d.payment_method === 'COD') h += b('pl', 'prepaid', 'Prepaid link');
    h += b('nt', 'wrong_number', 'Wrong no.');
    if (!inhouse) h += b('nt', 'escalated', 'Escalate');
    h += b('nt', 'dnc', 'Do not call') + b('nt', 'note', 'Note') + '</div>';
    return h;
  }

  // ---------------------------------------------------------------- modal
  var CFG = {
    confirmed: { t: 'Confirm order', m: 'Confirm this order?', c: 'g', b: 'Yes, confirm' },
    cancelled: { t: 'Cancel order', m: 'Cancel this order? A reason is required.', c: 'r', b: 'Yes, cancel order', reason: true },
    dnp: { t: 'Did not pick up (DNP)', m: 'Record a DNP attempt?', c: 'y', b: 'Record DNP' },
    callback: { t: 'Schedule callback', c: 'p', b: 'Schedule callback', cb: true },
    address_fix: { t: 'Fix address', c: 'y', b: 'Save address', addr: true },
    wrong_number: { t: 'Wrong number / invalid details', m: 'Mark this number as wrong / invalid? The lead leaves the queue.', c: 'y', b: 'Mark wrong number' },
    escalated: { t: 'Escalate to in-house team', m: 'Hand this lead to the in-house team. A note is required.', c: 'y', b: 'Escalate', noteReq: true },
    dnc: { t: 'Do not call', m: 'This lead will never return to the queue. Admin can review the list.', c: 'r', b: 'Flag Do Not Call' },
    note: { t: 'Add note', c: 'p', b: 'Save note', noteReq: true },
    prepaid: { t: 'Send prepaid link', c: 'c', b: 'Generate link' },
  };
  var COL = { g: ['var(--ds-brand)', '#000', 'rgba(16,185,129,.12)'], r: ['var(--ds-danger)', '#fff', 'rgba(239,68,68,.12)'], y: ['var(--ds-warn-ink)', '#000', 'rgba(245,158,11,.12)'], p: ['var(--ds-brand)', '#fff', 'rgba(129,140,248,.14)'], c: ['var(--ds-info)', '#000', 'rgba(6,182,212,.12)'] };

  var modal = document.createElement('div');
  modal.className = 'xm-bg';
  modal.innerHTML = '<div class="xm"><h3 id="xmT"></h3><div id="xmMsg" class="msg" style="display:none"></div>' +
    '<div id="xmRF" style="display:none"><label>Cancel reason *</label><select id="xmR"></select></div>' +
    '<div id="xmCF" style="display:none"><label>Call back on *</label><input type="datetime-local" id="xmC"></div>' +
    '<div id="xmAF" style="display:none"><label>Correct house / street address * <span style="text-transform:none;font-weight:500">(replaces the first address line)</span></label><textarea id="xmA" placeholder="e.g. Flat 402, Shreyas Tower, Link Road"></textarea>' +
      '<label style="display:flex;gap:8px;align-items:center;text-transform:none;font-weight:600;color:var(--ds-text)"><input type="checkbox" id="xmAC" style="width:auto"> Also confirm the order after saving the address</label></div>' +
    '<div id="xmLF" style="display:none"><div class="lk" id="xmL"></div><div class="xnote" id="xmLI"></div></div>' +
    '<div id="xmNF"><label id="xmNL">Notes</label><textarea id="xmN" placeholder="Add any notes…"></textarea></div>' +
    '<div class="ft" id="xmFt"></div></div>';
  document.body.appendChild(modal);

  function refreshAll() {
    try { if (typeof window.loadAll === 'function') window.loadAll(); } catch (e) {}
    document.dispatchEvent(new Event('crmx:changed')); loadBalance(); if (allTabActive()) loadOrders(); if (HIST_ID) openHistory(HIST_ID, true);
  }
  function unlock(id) { fetch('/api/cc/lead/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: id }) }).catch(function () {}); }
  function closeModal() {
    modal.classList.remove('on');
    if (CUR) unlock(CUR.id);
    CUR = null; refreshAll();
  }

  async function act(id, action) {
    var lead = ORDERS[id] || null;
    try {
      var l = await api('/api/cc/lead/lock', { order_id: id });
      if (!l.locked) { toast('Being handled by ' + (l.locked_by || 'another agent'), 'error'); return; }
    } catch (e) { if (e.message !== 'login') toast(e.message, 'error'); return; }
    if (!META) META = await api('/api/cc/meta');
    CUR = { id: id, action: action, lead: lead };
    var c = CFG[action], col = COL[c.c];
    $('xmT').textContent = c.t;
    var m = $('xmMsg'); m.style.display = c.m ? 'block' : 'none'; m.textContent = c.m || ''; m.style.background = col[2]; m.style.color = col[0];
    $('xmRF').style.display = c.reason ? 'block' : 'none';
    $('xmR').innerHTML = '<option value="">Select a reason…</option>' + Object.keys(META.cancel_reasons).map(function (k) { return '<option value="' + esc(k) + '">' + esc(META.cancel_reasons[k]) + '</option>'; }).join('');
    $('xmCF').style.display = c.cb ? 'block' : 'none'; $('xmC').value = '';
    $('xmAF').style.display = c.addr ? 'block' : 'none'; $('xmAC').checked = false;
    $('xmA').value = c.addr && lead ? (lead.shipping_address1 || '') : '';
    if (c.addr && lead) { m.style.display = 'block'; m.textContent = 'Current address: ' + (fullAddr(lead) || '—'); }
    $('xmLF').style.display = 'none';
    $('xmNF').style.display = 'block'; $('xmN').value = '';
    $('xmNL').textContent = c.noteReq ? 'Note *' : (action === 'cancelled' ? 'Note (required if reason is Other)' : 'Notes');
    $('xmFt').innerHTML = '<button class="xb nt" onclick="CRMX.close()">Go back</button>' +
      '<button id="xmGo" class="xb" style="background:' + col[0] + ';color:' + col[1] + '" onclick="CRMX.submit()">' + esc(c.b) + '</button>';
    modal.classList.add('on');
  }

  async function submit() {
    var cur = CUR, btn = $('xmGo'); if (!cur) return;
    var notes = $('xmN').value.trim();
    btn.disabled = true;
    try {
      if (cur.action === 'note') {
        if (!notes) throw new Error('Note is empty');
        await api('/api/cc/lead/note', { order_id: cur.id, note: notes });
        toast('Note saved'); done(cur); return;
      }
      if (cur.action === 'prepaid') { await sendPrepaid(cur, false); return; }
      var body = { order_id: cur.id, disposition: cur.action, notes: notes };
      if (cur.action === 'address_fix') {
        body.new_address = $('xmA').value.trim();
        if (!body.new_address) throw new Error('Enter the corrected address');
        await api('/api/cc/lead/disposition', body);
        if ($('xmAC').checked) { await api('/api/cc/lead/disposition', { order_id: cur.id, disposition: 'confirmed', notes: notes }); toast('Address saved and order confirmed'); }
        else toast('Address saved. The lead stays in your queue: call and confirm it.');
        done(cur); return;
      }
      if (cur.action === 'cancelled') { body.reason_code = $('xmR').value; if (!body.reason_code) throw new Error('Select a cancel reason'); }
      if (cur.action === 'callback') {
        var v = $('xmC').value; if (!v) throw new Error('Pick a callback date and time');
        body.callback_at = new Date(v).toISOString();
      }
      if (cur.action === 'escalated' && !notes) throw new Error('Add a note for the escalation');
      var d = await api('/api/cc/lead/disposition', body);
      var extra = d.dnp ? ' (DNP today: ' + d.dnp.todayCount + '/' + META.dnp_rules.max_daily + ')' : '';
      toast('Saved: ' + cur.action.replace('_', ' ') + extra);
      done(cur);
    } catch (e) {
      if (e.message !== 'login') toast(e.message, 'error');
      btn.disabled = false;
    }
  }
  function done(cur) { modal.classList.remove('on'); CUR = null; unlock(cur.id); refreshAll(); }

  async function sendPrepaid(cur, force) {
    var d = await api('/api/cc/lead/prepaid-link', { order_id: cur.id, force: !!force });
    var phone = String((cur.lead && cur.lead.customer_phone) || '').replace(/\D/g, '');
    var text = 'Hello, please pay ₹' + d.amount + ' to confirm your Jaadu Diet order: ' + d.short_url;
    var m = $('xmMsg'); m.style.display = 'block'; m.textContent = d.reused ? 'An open link already exists (sent by ' + d.sent_by + ').' : 'Payment link created.';
    $('xmRF').style.display = $('xmCF').style.display = $('xmNF').style.display = 'none';
    $('xmLF').style.display = 'block'; $('xmL').textContent = d.short_url;
    $('xmLI').textContent = '₹' + d.amount + '. The order turns Prepaid (and Shopify is updated) once the customer pays.';
    $('xmFt').innerHTML = '<button class="xb nt" onclick="CRMX.close()">Close</button><button class="xb nt" id="xmNew">New link</button><button class="xb nt" id="xmCp">Copy</button>' +
      '<a class="xb pl" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/' + (phone.length === 10 ? '91' + phone : phone) + '?text=' + encodeURIComponent(text) + '">WhatsApp</a>';
    $('xmCp').onclick = function () { navigator.clipboard.writeText(d.short_url).then(function () { toast('Link copied'); }); };
    $('xmNew').onclick = async function () { try { await sendPrepaid(cur, true); } catch (e) { toast(e.message, 'error'); } };
  }

  // ---------------------------------------------------------------- panel
  var panel = document.createElement('div');
  panel.className = 'xp';
  panel.innerHTML =
    '<div class="row">' +
      '<div><label>From date</label><input type="date" id="xFrom"></div>' +
      '<div><label>To date</label><input type="date" id="xTo"></div>' +
      '<button class="xq" data-q="0">Today</button><button class="xq" data-q="1">Yesterday</button>' +
      '<button class="xq" data-q="7">Last 7 days</button><button class="xq" data-q="30">Last 30 days</button>' +
      '<div><label>Status</label><select id="xStatus"><option value="">All</option><option value="pending">Pending</option>' +
        '<option value="callback">Callbacks</option><option value="dnp">DNP (not picked)</option><option value="confirmed">Confirmed</option>' +
        '<option value="unreachable">Unreachable (7 days over)</option><option value="cancelled">Cancelled</option><option value="wrong_number">Wrong number</option><option value="dnc">Do not call</option>' +
        '<option value="prepaid">Prepaid</option>' +
        '<optgroup label="Lead board"><option value="to_call_now">To call right now</option><option value="fresh">Fresh (never called)</option><option value="not_connected">Not connected</option>' +
        '<option value="nc_1">Not connected - 1 attempt</option><option value="nc_2">Not connected - 2 attempts</option><option value="nc_3_plus">Not connected - 3+ attempts</option>' +
        '<option value="callback_due">Callbacks due now</option><option value="callback_later">Callbacks later</option><option value="in_progress">Spoke, not decided</option>' +
        '<option value="short_open">Short address to fix</option><option value="short_open_confirmed">Short address - confirmed</option><option value="short_open_pending">Short address - pending</option></optgroup></select></div>' +
      '<div><label>Product</label><select id="xProduct"><option value="">All products</option></select></div>' +
      '<div><label>Search</label><input type="text" id="xSearch" placeholder="Order / phone / name" style="width:160px"></div>' +
      '<button class="xq on" id="xApply">Apply</button>' +
    '</div>' +
    '<div class="row" style="margin-top:10px">' +
      '<div><label>Attempts</label><select id="xAtt"><option value="">Any</option><option value="0">0 - never called</option><option value="1">1</option><option value="2">2</option><option value="3p">3 or more</option></select></div>' +
      '<div><label>Last result</label><select id="xLast"><option value="">Any</option><option value="dnp">Did not pick up</option><option value="callback">Callback</option><option value="address_fix">Address fixed</option><option value="wrong_number">Wrong number</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select></div>' +
      '<div><label>Worked by</label><select id="xAgent"><option value="">Anyone</option></select></div>' +
      '<div><label>Follow-up</label><select id="xFollow"><option value="">Any</option><option value="due">Due now</option><option value="today">Today</option><option value="later">Later</option><option value="none">None set</option></select></div>' +
      '<div><label>City / state / PIN</label><input type="text" id="xCity" style="width:140px"></div>' +
      '<div><label>Called between</label><div style="display:flex;gap:4px"><input type="date" id="xCalledFrom"><input type="date" id="xCalledTo"></div></div>' +
    '</div>' +
    '<div class="row" style="margin-top:10px"><span style="font-size:0.75rem;color:var(--ds-muted);font-weight:700">DOWNLOAD (CSV):</span>' +
      '<button class="xdl" data-dl="daily">My calls per day</button>' +
      '<button class="xdl" data-dl="calls">Call log</button>' +
      '<button class="xdl" data-dl="orders">Orders list</button></div>';

  var anchor = $('kpi') || $('kpiRibbon');
  if (anchor) anchor.style.display = 'none';

  // All Orders tab
  var tabsBar = document.querySelector('.tabs-bar');
  var allTab = document.createElement('div');
  allTab.className = 'tab'; allTab.dataset.tab = 'xall';
  allTab.innerHTML = 'Lead Workbench <span class="count" id="xCount">0</span>';
  tabsBar.appendChild(allTab);
  var allContent = document.createElement('div');
  allContent.className = 'tab-content'; allContent.id = 'tab-xall';
  allContent.innerHTML = '<div class="toolbar"><span class="toolbar-info" id="xInfo">Pick a count at the top, or open Filters</span>' +
    '<button class="xq" id="xFilt" style="margin-left:auto">Filters &amp; downloads ▾</button>' +
    '<span class="xrq" id="xRq"><b style="font-size:0.75rem">Send these back to calling:</b>' +
    '<button class="xq" data-rq="inhouse">To Aman</button><button class="xq" data-rq="cc">To call centre</button><button class="xq" data-rq="keep">Same team</button></span></div>' +
    '<div id="xBulk" class="xbulk" style="display:none"></div>' +
    '<div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="xAll" title="Select all"></th><th>Order date</th><th>Order</th><th>Product</th><th>Customer</th><th>Phone</th><th>Address</th><th>Amount</th><th>Status</th><th>Handled by</th><th>Last call</th><th>Attempts</th><th>Actions</th></tr></thead>' +
    '<tbody id="xBody"></tbody></table></div>';
  var lastContent = document.querySelectorAll('.tab-content'); lastContent = lastContent[lastContent.length - 1];
  lastContent.parentNode.insertBefore(allContent, lastContent.nextSibling);
  allContent.insertBefore(panel, allContent.firstChild);
  panel.style.margin = '0 0 14px'; panel.style.display = 'none';
  $('xFilt').addEventListener('click', function () { panel.style.display = panel.style.display === 'none' ? '' : 'none'; });
  function showAllTab() {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (t) { t.classList.remove('active'); });
    allTab.classList.add('active'); allContent.classList.add('active');
  }
  function allTabActive() { return allContent.classList.contains('active'); }
  allTab.addEventListener('click', function () { showAllTab(); loadOrders(); });

  var COHORT = false, SCOPE_NOW = null, LISTLABEL = '';
  function qs(extra) {
    var p = new URLSearchParams();
    if ($('xFrom').value) p.set('from', $('xFrom').value);
    if ($('xTo').value) p.set('to', $('xTo').value);
    p.set('scope', SCOPE_NOW || SCOPE);
    if (COHORT) p.set('cohort', '1');
    if ($('xProduct').value) p.set('product', $('xProduct').value);
    [['xAtt', 'attempts'], ['xLast', 'last'], ['xAgent', 'agent'], ['xFollow', 'followup'], ['xCity', 'city'], ['xCalledFrom', 'called_from'], ['xCalledTo', 'called_to']].forEach(function (m) { var v = $(m[0]).value.trim(); if (v) p.set(m[1], v); });
    Object.keys(extra || {}).forEach(function (k) { if (extra[k]) p.set(k, extra[k]); });
    return p.toString();
  }

  function productName(d) {
    try {
      var items = typeof d.line_items === 'string' ? JSON.parse(d.line_items) : (d.line_items || []);
      if (!items.length) return '—';
      var qty = items.reduce(function (s, i) { return s + (Number(i.quantity) > 0 ? Number(i.quantity) : 1); }, 0); return (items[0].title || '—') + ' <b style="margin-left:6px;padding:1px 7px;border-radius:6px;background:var(--ds-brand-tint);color:var(--ds-brand);white-space:nowrap">Qty ' + qty + '</b>';
    } catch(e) { return '—'; }
  }

  function statusBadge(o) {
    var s = o.dnc ? 'dnc' : (o.confirmation_status === 'pending' && o.callback_at ? 'callback' : (o.confirmation_status === 'pending' && o.last_disposition === 'dnp' ? 'dnp' : o.confirmation_status));
    var label = { dnc: 'Do not call', callback: 'Callback ' + fmtDate(o.callback_at), dnp: 'DNP', wrong_number: 'Wrong number' }[s] || s;
    return '<span class="xs ' + esc(s) + '">' + esc(label) + '</span>' + (o.converted_to_prepaid ? ' <span class="xs confirmed">Prepaid</span>' : '');
  }

  async function loadOrders() {
    $('xInfo').textContent = 'Loading…';
    try {
      var data = await api('/api/cc/orders?' + qs({ status: $('xStatus').value, search: $('xSearch').value.trim() }));
      ORDERS = {}; data.forEach(function (o) { ORDERS[o.id] = o; });
      SEL = {}; renderBulk(); $('xAll').checked = false;
      $('xCount').textContent = data.length;
      $('xInfo').textContent = (LISTLABEL ? LISTLABEL + ' · ' : '') + data.length + ' orders' + (data.length >= 500 ? ' (showing first 500 — use Download for all)' : '') + ' · ' + new Date().toLocaleTimeString();
      $('xBody').innerHTML = data.length ? data.map(function (o) {
        var open = o.confirmation_status === 'pending' && !o.dnc && o.order_status !== 'cancelled';
        return '<tr><td><input type="checkbox" class="xck" data-id="' + esc(o.id) + '"></td><td>' + esc(fmtDate(o.order_date)) + '</td>' +
          '<td><a href="#" class="order-id" data-hist="' + esc(o.id) + '" style="color:var(--ds-brand);text-decoration:none" title="Open call history">' + esc(o.order_name || '#' + o.shopify_order_id) + '</a><div class="sub-text">' + esc(o.payment_method) + '</div></td>' +
          '<td><span style="font-size:0.75rem;padding:2px 6px;border-radius:4px;background:#1e3a5f;color:#93c5fd">' + productName(o) + '</span></td>' +
          '<td>' + esc(o.customer_name || '—') + '</td>' +
          '<td><a href="tel:' + esc(o.customer_phone) + '" class="phone-link">' + esc(o.customer_phone) + '</a></td>' +
          '<td class="addr">' + addrCell(o) + '</td>' +
          '<td><strong>₹' + esc(o.total_price) + '</strong></td>' +
          '<td>' + statusBadge(o) + '</td>' +
          '<td>' + (o.assigned_to === 'InHouse' ? 'Aman' : 'Call centre') + '<div class="sub-text">' + esc(o.assigned_agent || '') + '</div></td>' +
          '<td>' + esc(o.last_disposition || '—') + '<div class="sub-text">' + (o.last_call_at ? esc(fmtDate(o.last_call_at)) : '') + '</div></td>' +
          '<td>' + (o.call_count != null ? o.call_count : (o.call_attempts || 0)) + '</td>' +
          '<td>' + (open ? buttons(o) : '<button class="xb nt" onclick="CRMX.act(\'' + esc(o.id) + '\',\'note\')">Note</button>') +
            '<div class="xbg" style="margin-top:5px"><button class="xb nt" data-hist="' + esc(o.id) + '">History</button><a class="xb cf" style="text-decoration:none" target="_blank" rel="noopener" href="' + waLink(o) + '">WhatsApp</a></div></td></tr>';
      }).join('') : '<tr><td colspan="13"><div class="empty-state"><div class="empty-title">No orders match these filters</div></div></td></tr>';
    } catch (e) { if (e.message !== 'login') $('xInfo').textContent = 'Could not load: ' + e.message; }
  }

  function setRange(daysBack) {
    var t = today();
    if (daysBack === 1) { $('xFrom').value = $('xTo').value = addDays(t, -1); }
    else if (daysBack === 0) { $('xFrom').value = $('xTo').value = t; }
    else { $('xFrom').value = addDays(t, -(daysBack - 1)); $('xTo').value = t; }
  }
  function apply() {
    if ($('xFrom').value && $('xTo').value && $('xTo').value < $('xFrom').value) { toast('"To" date is before "From" date', 'error'); return; }
    if ($('xStatus').value || $('xSearch').value.trim() || allTabActive()) { showAllTab(); loadOrders(); }
  }
  panel.querySelectorAll('.xq[data-q]').forEach(function (b) {
    b.addEventListener('click', function () { setRange(Number(b.dataset.q)); apply(); });
  });
  $('xApply').addEventListener('click', function () { showAllTab(); apply(); loadOrders(); });
  $('xStatus').addEventListener('change', function () { COHORT = false; LISTLABEL = ''; showAllTab(); loadOrders(); });
  $('xProduct').addEventListener('change', function () { showAllTab(); loadOrders(); });
  ['xAtt', 'xLast', 'xAgent', 'xFollow', 'xCalledFrom', 'xCalledTo'].forEach(function (id) { $(id).addEventListener('change', function () { showAllTab(); loadOrders(); }); });
  $('xCity').addEventListener('keydown', function (e) { if (e.key === 'Enter') { showAllTab(); loadOrders(); } });
  $('xSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') { showAllTab(); loadOrders(); } });
  panel.querySelectorAll('.xdl').forEach(function (b) {
    b.addEventListener('click', function () {
      var extra = { type: b.dataset.dl };
      if (b.dataset.dl === 'orders') { extra.status = $('xStatus').value; extra.search = $('xSearch').value.trim(); }
      var a = document.createElement('a'); a.href = '/api/cc/export?' + qs(extra); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    });
  });

  // ---- send DNP / unreachable leads back to calling (Aman and admin only)
  function updateRq() {
    var s = $('xStatus').value;
    $('xRq').classList.toggle('on', (ROLE === 'aman' || ROLE === 'admin') && (s === 'dnp' || s === 'unreachable'));
  }
  $('xStatus').addEventListener('change', updateRq);
  $('xRq').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-rq]'); if (!b) return;
    var status = $('xStatus').value, body = { status: status, assign: b.dataset.rq, from: $('xFrom').value, to: $('xTo').value };
    var team = { inhouse: "Aman's queue", cc: 'the call-centre queue', keep: 'the same team' }[b.dataset.rq];
    try {
      var d = await api('/api/cc/requeue', Object.assign({ dry_run: true }, body));
      if (!d.count) { toast('No ' + (status === 'dnp' ? 'DNP' : 'unreachable') + ' leads with order dates ' + d.from + ' to ' + d.to, 'error'); return; }
      if (!confirm(d.count + ' ' + (status === 'dnp' ? 'DNP' : 'unreachable') + ' lead(s) with order dates ' + d.from + ' to ' + d.to + ' will go back into ' + team +
        ' as fresh leads (their 7-day follow-up window restarts today). Continue?')) return;
      var r = await api('/api/cc/requeue', body);
      toast(r.moved + ' lead(s) sent back to calling');
      refreshAll();
    } catch (err) { if (err.message !== 'login') toast(err.message, 'error'); }
  });
  api('/api/cc/meta').then(function (m) { ROLE = m.agent.role; updateRq(); (m.agents || []).forEach(function (a) { $('xAgent').insertAdjacentHTML('beforeend', '<option value="' + esc(a.display_name) + '">' + esc(a.display_name) + (a.role === 'aman' ? ' (Aman)' : a.role === 'admin' ? ' (admin)' : '') + '</option>'); }); (m.products || []).forEach(function (p) { $('xProduct').insertAdjacentHTML('beforeend', '<option value="' + esc(p.key) + '">' + esc(p.name) + '</option>'); }); }).catch(function () {});

  // ---- Aman: workload bar ("get more leads from the call centre")
  var bal = null;
  if (PAGE === 'aman' && window.CRMX_BALANCE_BAR === true) {   // off by default: the call centre works new COD leads, Aman gets handed-over ones
    bal = document.createElement('div');
    bal.className = 'xbal'; bal.style.margin = '0 24px 8px'; bal.style.padding = '6px 12px';
    bal.innerHTML = '<span>Your open leads: <b id="xbA">–</b></span><span>Call-centre queue waiting: <b id="xbC">–</b></span>' +
      '<button class="xdl" id="xbGo">Get 15 more leads from the call centre</button>';
    tabsBar.parentNode.insertBefore(bal, tabsBar);
    $('xbGo').addEventListener('click', async function () {
      var b = this; b.disabled = true;
      try {
        var r = await api('/api/cc/balance/pull', { count: 15 });
        toast(r.moved ? r.moved + ' lead(s) moved to your queue' : 'The call centre has no free leads to share right now', r.moved ? 'success' : 'error');
        try { if (typeof window.loadAll === 'function') window.loadAll(); } catch (e) {}
        loadBalance();
      } catch (e) { if (e.message !== 'login') toast(e.message, 'error'); }
      b.disabled = false;
    });
  }
  async function loadBalance() {
    if (!bal) return;
    try {
      var d = await api('/api/cc/balance/status'), s = d.settings;
      $('xbA').textContent = d.aman_open; $('xbC').textContent = d.cc_open;
      bal.classList.toggle('hot', d.aman_open < s.min_aman && d.cc_movable > 0);
      var hh = function (h) { var x = Math.floor(h), m = Math.round((h - x) * 60); return x + ':' + (m < 10 ? '0' : '') + m; };
      bal.title = d.auto
        ? 'Auto-share is ON from ' + hh(s.start_hour) + ' to ' + hh(s.end_hour) + ' IST: when you have fewer than ' + s.min_aman + ' open leads, up to ' + s.batch + ' of the oldest call-centre leads move to you every 10 minutes' + (d.in_window ? '.' : ' (outside that time right now).')
        : 'Auto-share is OFF. Use the button to take leads from the call centre.';
    } catch (e) {}
  }
  loadBalance();
  setInterval(loadBalance, 60000);

  setRange(0);

  // Called by the funnel boxes: show exactly the orders behind a number (same rules as the report).
  function openOrders(status, range, team, product, label) {
    LISTLABEL = label || '';
    $('xFrom').value = range.from; $('xTo').value = range.to; $('xStatus').value = status; $('xSearch').value = '';
    $('xProduct').value = product || ''; COHORT = true; SCOPE_NOW = team === 'all' ? 'all' : team === 'inhouse' ? 'inhouse' : team === 'cc' ? 'cc' : null;
    updateRq(); showAllTab(); loadOrders();
    allContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Lead Workbench: select orders, bulk actions, call history
  var SEL = {}, HIST_ID = null;
  function selIds() { return Object.keys(SEL); }
  function waLink(o) {
    var ph = String(o.customer_phone || '').replace(/\D/g, '').slice(-10);
    var msg = 'Hello ' + (o.customer_name || '') + ', this is Jaadu Diet. We received your order ' + (o.order_name || '') + ' of ₹' + o.total_price + '. Please reply CONFIRM to confirm your order.';
    return 'https://wa.me/91' + ph + '?text=' + encodeURIComponent(msg);
  }
  function renderBulk() {
    var ids = selIds(), el = $('xBulk');
    if (!ids.length) { el.style.display = 'none'; return; }
    var power = ROLE === 'aman' || ROLE === 'admin';
    el.style.display = 'flex';
    el.innerHTML = '<b>' + ids.length + ' selected</b>' +
      (power ? '<button class="xq" data-bulk="InHouse">Move to Aman</button><button class="xq" data-bulk="CC">Move to call centre</button><button class="xq" data-bulk="cb">Schedule callback…</button>' : '') +
      '<button class="xq" data-bulk="csv">Export selected</button><button class="xq" data-bulk="clear">Clear</button>';
  }
  $('xBody').addEventListener('change', function (e) {
    if (!e.target.classList.contains('xck')) return;
    if (e.target.checked) SEL[e.target.dataset.id] = 1; else delete SEL[e.target.dataset.id];
    renderBulk();
  });
  allContent.addEventListener('change', function (e) {
    if (e.target.id !== 'xAll') return;
    allContent.querySelectorAll('.xck').forEach(function (c) { c.checked = e.target.checked; if (c.checked) SEL[c.dataset.id] = 1; else delete SEL[c.dataset.id]; });
    renderBulk();
  });
  function exportSelected(ids) {
    var head = ['Order', 'Order date', 'Customer', 'Phone', 'Product', 'Qty', 'Amount', 'Team', 'Last result', 'Last call', 'Calls', 'Status', 'City', 'PIN', 'Address'];
    var rows = ids.map(function (id) {
      var o = ORDERS[id]; if (!o) return null;
      return [o.order_name, fmtDate(o.order_date), o.customer_name, o.customer_phone, o.sku_names || '', o.qty_total || '', o.total_price, o.assigned_to === 'InHouse' ? 'Aman' : 'Call centre',
        o.last_disposition || '', o.last_call_at ? fmtDate(o.last_call_at) : '', o.call_count != null ? o.call_count : '', o.confirmation_status, o.shipping_city, o.shipping_zip, fullAddr(o)];
    }).filter(Boolean);
    var text = [head].concat(rows).map(function (r) {
      return r.map(function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = 'selected_orders.csv'; document.body.appendChild(a); a.click(); a.remove();
  }
  function bulkCallback(ids) {
    var ov = document.createElement('div'); ov.className = 'xm-bg on';
    ov.innerHTML = '<div class="xm"><h3>Schedule a callback for ' + ids.length + ' order(s)</h3><label>Call back on *</label><input type="datetime-local" id="xbcWhen">' +
      '<label>Note (optional)</label><textarea id="xbcNote"></textarea><div class="ft"><button class="xb nt" data-x="no">Cancel</button><button class="xb cb" data-x="ok">Schedule</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-x]');
      if (!b) { if (e.target === ov) ov.remove(); return; }
      if (b.dataset.x === 'no') return ov.remove();
      var v = $('xbcWhen').value; if (!v) { toast('Pick a date and time', 'error'); return; }
      try {
        var r = await api('/api/cc/leads/callback', { ids: ids, callback_at: new Date(v).toISOString(), note: $('xbcNote').value.trim() });
        toast(r.updated + ' callback(s) scheduled' + (r.skipped ? ', ' + r.skipped + ' skipped (already closed)' : '')); ov.remove(); refreshAll();
      } catch (err) { if (err.message !== 'login') toast(err.message, 'error'); }
    });
  }
  $('xBulk').addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-bulk]'); if (!b) return;
    var k = b.dataset.bulk, ids = selIds();
    try {
      if (k === 'clear') { SEL = {}; allContent.querySelectorAll('.xck,#xAll').forEach(function (c) { c.checked = false; }); renderBulk(); return; }
      if (k === 'csv') return exportSelected(ids);
      if (k === 'cb') return bulkCallback(ids);
      if (!confirm('Move ' + ids.length + ' order(s) to ' + (k === 'InHouse' ? 'Aman' : 'the call centre') + '? Orders already confirmed / cancelled, or being worked on right now, are skipped.')) return;
      var r = await api('/api/cc/leads/reassign', { ids: ids, to: k });
      toast(r.moved + ' moved' + (r.skipped ? ', ' + r.skipped + ' skipped (closed, already there, or being worked on)' : '')); refreshAll();
    } catch (err) { if (err.message !== 'login') toast(err.message, 'error'); }
  });

  // ---- call history panel (every attempt, notes, payment links, WhatsApp / IVR results)
  var drawer = document.createElement('div');
  drawer.className = 'xdr';
  drawer.innerHTML = '<div class="xdr-in"><button class="xdr-x" title="Close">×</button><div id="xdrBody"></div></div>';
  document.body.appendChild(drawer);
  function closeHistory() { drawer.classList.remove('on'); HIST_ID = null; }
  drawer.querySelector('.xdr-x').onclick = closeHistory;
  drawer.addEventListener('click', async function (e) {
    if (e.target === drawer) return closeHistory();
    var re = e.target.closest('[data-re]');
    if (re && HIST_ID) {
      try {
        var r = await api('/api/cc/leads/reassign', { ids: [HIST_ID], to: re.dataset.re });
        toast(r.moved ? 'Order moved' : 'Not moved (already there, closed, or being worked on)', r.moved ? 'success' : 'error'); refreshAll();
      } catch (err) { if (err.message !== 'login') toast(err.message, 'error'); }
    }
  });
  document.addEventListener('click', function (e) {
    var h = e.target.closest('[data-hist]');
    if (h) { e.preventDefault(); openHistory(h.dataset.hist); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.classList.contains('on')) closeHistory(); });
  var HL = { dnp: 'Did not pick up', confirmed: 'Confirmed', cancelled: 'Cancelled', callback: 'Callback set', address_fix: 'Address fixed', wrong_number: 'Wrong number', dnc: 'Do not call', escalated: 'Escalated', reassigned: 'Moved to another team', requeued: 'Sent back to calling', callback_scheduled: 'Callback scheduled', rnr: 'No answer' };
  function whoLabel(w) { return ({ whatsapp: 'WhatsApp', whatsapp_late: 'WhatsApp', ivr_call: 'IVR call', ivr_late: 'IVR call', sheet: 'Sheet', system: 'System' })[w] || w || ''; }
  async function openHistory(id, quiet) {
    HIST_ID = id; drawer.classList.add('on');
    if (!quiet) $('xdrBody').innerHTML = '<div class="xnote" style="padding:20px">Loading…</div>';
    try {
      var d = await api('/api/cc/lead/history?order_id=' + encodeURIComponent(id)), o = d.order;
      ORDERS[o.id] = Object.assign({}, ORDERS[o.id] || {}, o);          // lets the action buttons work from this panel
      var open = o.confirmation_status === 'pending' && !o.dnc && o.order_status !== 'cancelled';
      var next = o.confirmation_status === 'confirmed' ? 'Confirmed - nothing more to do' : o.confirmation_status === 'cancelled' ? 'Cancelled' : o.dnc ? 'Do not call'
        : o.callback_at ? 'Callback ' + fmtDate(o.callback_at) : d.attempts === 0 ? 'Fresh lead - call now' : d.spoke ? 'Spoke to the customer - confirm or cancel' : 'Not connected - attempt ' + (d.attempts + 1) + ' is next';
      var items = d.timeline.map(function (t) {
        var head = t.kind === 'call' ? '<b>Attempt ' + t.attempt + '</b> · ' + esc(HL[t.disposition] || t.disposition)
          : t.kind === 'note' ? '<b>Note</b>' : t.kind === 'link' ? '<b>Payment link sent</b>'
          : '<b>' + esc(whoLabel(t.who)) + '</b> · ' + esc(HL[t.disposition] || String(t.disposition).replace(/_/g, ' '));
        var line = (t.kind === 'event' ? '' : esc(whoLabel(t.who)) + ' · ') + esc(fmtDate(t.at));
        var extra = (t.reason ? '<div class="xtl-n">Reason: ' + esc(t.reason) + '</div>' : '') + (t.callback_at ? '<div class="xtl-n">Callback: ' + esc(fmtDate(t.callback_at)) + '</div>' : '') + (t.note ? '<div class="xtl-n">' + esc(t.note) + '</div>' : '');
        return '<li class="xtl ' + t.kind + '"><div>' + head + '</div><div class="xtl-t">' + line + '</div>' + extra + '</li>';
      }).join('');
      var power = ROLE === 'aman' || ROLE === 'admin', other = o.assigned_to === 'InHouse' ? 'CC' : 'InHouse';
      var prod = (o.skus || []).map(function (s) { return esc(s.name) + ' × ' + s.qty; }).join(', ');
      $('xdrBody').innerHTML =
        '<h3>' + esc(o.order_name || '#' + o.shopify_order_id) + ' <span class="xs ' + esc(o.confirmation_status) + '">' + esc(o.dnc ? 'Do not call' : o.confirmation_status) + '</span></h3>' +
        '<div class="xdr-sub">' + esc(o.customer_name || '—') + ' · <a class="phone-link" href="tel:' + esc(o.customer_phone) + '">' + esc(o.customer_phone) + '</a> · <b>₹' + esc(o.total_price) + '</b>' + (prod ? ' · ' + prod : '') + '</div>' +
        '<div class="xdr-addr">' + addrCell(o) + '</div>' +
        '<div class="xdr-next">Next: ' + esc(next) + '</div>' +
        '<div class="xdr-acts"><a class="xb pl" href="tel:' + esc(o.customer_phone) + '">Call customer</a><a class="xb cf" target="_blank" rel="noopener" href="' + waLink(o) + '">WhatsApp</a></div>' +
        (open ? '<div class="xdr-btns">' + buttons(ORDERS[o.id]) + '</div>' : '') +
        '<div class="xdr-re">With <b>' + (o.assigned_to === 'InHouse' ? 'Aman' : 'the call centre') + '</b>' + (o.assigned_agent ? ' (last: ' + esc(o.assigned_agent) + ')' : '') +
          (power && open ? ' <button class="xq" data-re="' + other + '">Move to ' + (other === 'CC' ? 'call centre' : 'Aman') + '</button>' : '') + '</div>' +
        '<h4>Calling history · ' + d.attempts + ' attempt' + (d.attempts === 1 ? '' : 's') + '</h4>' +
        (items ? '<ul class="xtls">' + items + '</ul>' : '<div class="xnote">Nothing has happened on this order yet.</div>');
    } catch (e) { if (e.message !== 'login') $('xdrBody').innerHTML = '<div class="xnote" style="padding:20px">Could not load: ' + esc(e.message) + '</div>'; }
  }

  // ---- Smart queue. The server (lib/queue.js) already sorts the leads and gives each a priority {tier, ready, label, reason};
  // this only draws the filter chips and the reason line, and hides leads that are not ready yet.
  var Q = { filter: 'ready' };
  var QTABS = [['ready', 'Ready now'], ['callback_due', 'Callbacks due'], ['handed_over', 'Handed over'], ['fresh', 'Fresh'], ['retry', 'Not connected, retry due'], ['wait', 'Not yet due'], ['capped', 'Done for today'], ['all', 'All']];
  function qMatch(d, f) {
    var p = d.priority || { ready: true, tier: 'fresh' };
    if (f === 'all') return true; if (f === 'ready') return !!p.ready;
    if (f === 'fresh') return p.tier === 'fresh' || p.tier === 'fresh_new' || p.tier === 'fresh_overdue';
    return p.tier === f;
  }
  function qChips(data) {
    return QTABS.map(function (t) {
      var n = data.filter(function (d) { return qMatch(d, t[0]); }).length;
      if (!n && Q.filter !== t[0] && t[0] !== 'ready' && t[0] !== 'all') return '';   // empty views stay out of the way
      return '<button class="qchip' + (Q.filter === t[0] ? ' on' : '') + (t[0] === 'callback_due' && n ? ' hot' : '') + '" data-q="' + t[0] + '">' + t[1] + '<b>' + n + '</b></button>';
    }).join('');
  }
  function qRows(data) { return data.filter(function (d) { return qMatch(d, Q.filter); }); }
  function qWhy(d, index) {
    var p = d.priority; if (!p) return '';
    return '<div class="qwhy q-' + esc(p.tier) + '">' + (index === 0 && p.ready ? '<span class="qnext">NEXT UP</span>' : '') + '<b>' + esc(p.label) + '</b>' + esc(p.reason) + '</div>';
  }
  function qClass(d, index) { var p = d.priority; return (p && !p.ready ? ' q-dim' : '') + (index === 0 && p && p.ready ? ' q-first' : ''); }
  function qBind(el, redraw) { if (el.__qb) return; el.__qb = 1; el.addEventListener('click', function (e) { var b = e.target.closest('[data-q]'); if (!b) return; Q.filter = b.getAttribute('data-q'); redraw(); }); }
  // ---- Autopilot: tell the server this person is working (every minute while the page is open), and show the 2 PM target and connectivity.
  function apBeat() { try { if (document.visibilityState === 'visible') fetch('/api/cc/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (e) {} }
  function apBanner() {
    fetch('/api/cc/autopilot/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var el = document.getElementById('apBar');
      if (!el) { el = document.createElement('div'); el.id = 'apBar'; el.className = 'apbar'; var anchor = document.getElementById('funnelMount') || document.querySelector('.header'); if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor); else document.body.insertBefore(el, document.body.firstChild); }
      var isAman = /aman/i.test(location.pathname), mine = isAman ? d.pace.aman : d.pace.cc, nm = isAman ? 'Aman' : 'Call centre', h = [];
      var left = mine.uncalled, deadline = d.rules.deadline_hour, over = mine.phase === 'after', bad = (mine.phase === 'active' && mine.behind) || (over && left > 0);
      if (mine.phase === 'before') h.push('<div class="km"><b>' + left + '</b><span>first call(s) needed by ' + (deadline > 12 ? deadline - 12 : deadline) + ' PM</span></div><div class="km-meta">Pace check starts at 11:00</div>');
      else if (mine.phase === 'active') h.push('<div class="km' + (bad ? ' bad' : '') + '"><b>' + left + '</b><span>first call(s) left by ' + (deadline > 12 ? deadline - 12 : deadline) + ' PM</span></div><div class="km-meta">' + mine.hours_left + ' h left · need ' + mine.needed_per_hour + ' an hour · ' + nm + ' doing ' + mine.rate_per_hour + (bad ? ' · behind by ' + mine.deficit : '') + '</div>');
      else h.push('<div class="km' + (bad ? ' bad' : '') + '"><b>' + left + '</b><span>' + (left ? 'order(s) placed before 1 PM never got a first call' : 'every order placed before 1 PM was called') + '</span></div>');
      if (d.connectivity.pct != null) h.push('<div class="km-conn"><span class="km-meta">Connectivity today</span><b class="' + (d.connectivity.pct >= d.connectivity.target ? 'ok' : 'warn') + '">' + d.connectivity.pct + '%</b><span class="km-meta">of ' + d.connectivity.target + '%</span></div>');
      var other = isAman ? d.presence.cc : d.presence.aman;
      if (d.mode === 'on' && d.in_shift && other.active === 0 && other.total) h.push('<div class="warn km-meta">' + (isAman ? 'Call centre' : 'Aman') + ' is not logged in: you cover their leads</div>');
      h.push('<span class="tag">Autopilot ' + (d.mode === 'on' ? 'on' : d.mode === 'dry' ? 'planning only' : 'off') + '</span>');
      el.innerHTML = h.join('');
    }).catch(function () {});
  }
  apBeat(); apBanner(); setInterval(function () { apBeat(); apBanner(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') apBeat(); });
  window.CRMX = { queue: { chips: qChips, rows: qRows, why: qWhy, cls: qClass, bind: qBind, ready: function (d) { return d.filter(function (x) { return qMatch(x, 'ready'); }).length; } }, history: openHistory, openOrders: openOrders, buttons: buttons, act: act, submit: submit, close: closeModal, fmtDate: fmtDate, addrCell: addrCell, fullAddr: fullAddr, register: function (list) { (list || []).forEach(function (o) { ORDERS[o.id] = o; }); } };
})();
