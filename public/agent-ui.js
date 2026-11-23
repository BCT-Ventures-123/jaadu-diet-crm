/* Admin "Agent" tab: the hourly manager brief (step 1 of the AI agent). It reads the numbers and writes what to do next. It changes nothing.
   Data: /api/cc/ops-brief (rules in lib/opsBrief.js, writer in lib/opsAgent.js). Uses helpers from admin.html ($, esc). */
(function () {
  var TZ = 'Asia/Kolkata';
  var tabsEl = $('tabs'), anchor = $('p-log');
  var t = document.createElement('div'); t.className = 'tab'; t.dataset.p = 'agent'; t.textContent = 'Agent';
  tabsEl.insertBefore(t, tabsEl.firstChild);
  var p = document.createElement('div'); p.className = 'pane'; p.id = 'p-agent'; anchor.parentNode.appendChild(p);

  var css = '.ag{padding:6px 0 28px;color:var(--ds-text);max-width:860px}.ag-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.ag-title{font-size:1.25rem;font-weight:800;margin-right:auto}' +
    '.ag-btn{background:var(--ds-surface);color:var(--ds-text);border:1px solid var(--ds-border-strong);border-radius:8px;padding:9px 14px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit}.ag-btn[disabled]{opacity:.5;cursor:default}' +
    '.ag-card{background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:10px;padding:16px}.ag-head{font-size:1.1875rem;font-weight:800;line-height:1.35}' +
    '.ag-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:0.75rem;color:var(--ds-muted);margin-bottom:8px}' +
    '.ag-chip{display:inline-block;font-size:0.6875rem;font-weight:800;border-radius:999px;padding:3px 9px;background:var(--ds-border);color:var(--ds-muted)}.ag-chip.ai{background:var(--ds-brand-tint);color:var(--ds-brand-strong)}' +
    '.ag-list{list-style:none;margin:12px 0 0;padding:0}.ag-list li{padding:12px 0;border-top:1px solid var(--ds-border);display:grid;grid-template-columns:96px 1fr;gap:4px 12px}' +
    '.ag-who{font-size:0.75rem;font-weight:800;color:var(--ds-brand-strong);padding-top:2px}.ag-what{font-weight:700;font-size:0.9375rem;line-height:1.45}.ag-why{grid-column:2;font-size:0.8125rem;color:var(--ds-muted);line-height:1.45}' +
    '.ag-good{margin-top:12px;padding-top:12px;border-top:1px solid var(--ds-border);font-size:0.875rem;color:var(--ds-brand-strong);font-weight:600}' +
    '.ag-note{margin-top:12px;background:var(--ds-warn-tint);color:var(--ds-warn-ink);border-radius:8px;padding:10px 12px;font-size:0.8125rem;line-height:1.5}' +
    '.ag h3{font-size:1rem;font-weight:800;margin:22px 0 6px}.ag-hist{list-style:none;margin:0;padding:0;font-size:0.8125rem}.ag-hist li{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--ds-border);color:var(--ds-muted)}.ag-hist li b{color:var(--ds-text);font-weight:600;flex:1}' +
    '.ag-err{background:var(--ds-danger-tint);color:var(--ds-danger);border-radius:8px;padding:10px 12px}.ag-load{padding:30px;text-align:center;color:var(--ds-muted)}.ag-msg{font-size:0.8125rem;font-weight:700;margin-bottom:8px}' +
    '@media(max-width:560px){.ag-list li{grid-template-columns:1fr}.ag-why{grid-column:1}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function at(iso) { return new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

  function render(d) {
    var b = d.brief, h = '';
    if (!b) { $('ag-body').innerHTML = '<div class="ag-card"><div class="ag-head">No brief yet.</div><div class="ag-meta">The brief is written once an hour during the shift (9 am to 8 pm). Press Refresh to write one now.</div></div>'; return; }
    h += '<div class="ag-card"><div class="ag-meta"><span class="ag-chip ' + (b.source === 'ai' ? 'ai' : '') + '">' + (b.source === 'ai' ? 'Written by AI (' + esc(b.model || '') + ')' : 'Plain brief (no AI)') + '</span><span>' + esc(at(b.created_at)) + ' India time</span></div>' +
      '<div class="ag-head">' + esc(b.headline) + '</div>';
    if (b.items.length) h += '<ul class="ag-list">' + b.items.map(function (i) { return '<li><div class="ag-who">' + esc(i.who) + '</div><div class="ag-what">' + esc(i.what) + '</div>' + (i.why ? '<div class="ag-why">' + esc(i.why) + '</div>' : '') + '</li>'; }).join('') + '</ul>';
    if (b.good) h += '<div class="ag-good">' + esc(b.good) + '</div>';
    if (b.note) h += '<div class="ag-note">' + esc(b.note) + '</div>';
    h += '</div>';
    if (!d.ai_on) h += '<div class="ag-note" style="margin-top:12px"><b>AI writing is off.</b> The brief above is the plain version built from the same numbers. To switch the AI on, the owner adds the variable ANTHROPIC_API_KEY to the web service in Railway.</div>';
    h += '<h3>Earlier briefs</h3><ul class="ag-hist">' + d.history.map(function (x) { return '<li><span>' + esc(at(x.created_at)) + '</span><b>' + esc(x.headline) + '</b><span>' + (x.source === 'ai' ? 'AI' : 'plain') + '</span></li>'; }).join('') + '</ul>';
    h += '<div class="ag-sub" style="font-size:0.75rem;color:var(--ds-muted);margin-top:14px;line-height:1.5">The numbers come from the CRM. The AI only chooses what matters and words it. If it uses a number the CRM did not give it, the plain brief is shown instead. This agent changes nothing in the CRM.</div>';
    $('ag-body').innerHTML = h;
  }

  function load(peek) {
    $('ag-body').innerHTML = '<div class="ag-load">' + (peek ? 'Loading…' : 'Writing the brief…') + '</div>';
    fetch('/api/cc/ops-brief').then(function (res) {
      if (res.status === 401) { location.href = '/login.html?next=/admin.html'; throw new Error('login'); }
      return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not load the brief'); return j; });
    }).then(render).catch(function (e) { if (e.message !== 'login') $('ag-body').innerHTML = '<div class="ag-err">' + esc(e.message) + '</div>'; });
  }
  function refresh() {
    var b = $('ag-refresh'); b.disabled = true; $('ag-body').innerHTML = '<div class="ag-load">Writing the brief…</div>';
    fetch('/api/cc/ops-brief/refresh', { method: 'POST' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not write the brief'); return j; }); })
      .then(function () { load(true); }).catch(function (e) { $('ag-body').innerHTML = '<div class="ag-err">' + esc(e.message) + '</div>'; })
      .then(function () { b.disabled = false; });
  }
  p.innerHTML = '<div class="ag"><div class="ag-top"><div class="ag-title">Agent: hourly brief</div><button class="ag-btn" id="ag-refresh">Write a new brief now</button></div><div id="ag-body"></div></div>';
  $('ag-refresh').onclick = refresh;
  t.onclick = function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active'); p.classList.add('active'); load(false);
  };
})();
