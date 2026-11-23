/* Shell for the work screens: four destinations instead of nine tabs, sub-views as pills, and lead tables labelled so they become cards on a phone.
   The existing tabs keep all their behaviour: this only drives them (a click on a destination clicks the first tab of its group). */
(function () {
  var PAGE = /aman/i.test(location.pathname) ? 'aman' : /cc-crm/i.test(location.pathname) ? 'cc' : null;
  if (!PAGE) return;
  var I = {
    work: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
    follow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg>',
    review: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    reports: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'
  };
  var NAV = PAGE === 'aman' ? [
    { id: 'work', label: 'Work', tabs: [['fresh', 'Leads to call'], ['repeat', 'Repeat customers']], badge: ['fresh'] },
    { id: 'follow', label: 'Follow-up', tabs: [['predelivery', 'Before delivery'], ['postdelivery', 'After delivery'], ['ndr', 'Undelivered (NDR)']], badge: ['predelivery', 'postdelivery', 'ndr'] },
    { id: 'review', label: 'Review', tabs: [['duplicates', 'Duplicates'], ['ccqueue', 'Call-centre queue']], badge: ['duplicates'] },
    { id: 'reports', label: 'Reports', tabs: [['amanreport', 'Daily report'], ['xall', 'Lead workbench']], badge: [] }
  ] : [
    { id: 'work', label: 'Work', tabs: [['fresh', 'Leads to call'], ['callbacks', 'Callbacks']], badge: ['fresh'] },
    { id: 'reports', label: 'Reports', tabs: [['ccreport', 'Daily report'], ['xall', 'Lead workbench']], badge: [] }
  ];
  var nav, sub, tries = 0;
  function tab(k) { return document.querySelector('.tab[data-tab="' + k + '"]'); }
  function cnt(k) { var t = tab(k), c = t && t.querySelector('.count'); return c ? (parseInt(c.textContent, 10) || 0) : 0; }
  function activeKey() { var a = document.querySelector('.tabs-bar .tab.active'); return a ? a.getAttribute('data-tab') : null; }
  function groupOf(k) { return NAV.filter(function (g) { return g.tabs.some(function (t) { return t[0] === k; }); })[0] || NAV[0]; }

  function renderSub(g, active) {
    if (!sub) return;
    if (g.tabs.length < 2) { sub.innerHTML = ''; sub.style.display = 'none'; return; }
    sub.style.display = '';
    sub.innerHTML = g.tabs.map(function (t) {
      var c = g.badge.indexOf(t[0]) >= 0 || t[0] === 'xall' || t[0] === 'repeat' || t[0] === 'callbacks' || t[0] === 'ccqueue' ? cnt(t[0]) : null;
      return '<button type="button" data-k="' + t[0] + '" class="' + (t[0] === active ? 'on' : '') + '">' + t[1] + (c ? '<b>' + c + '</b>' : '') + '</button>';
    }).join('');
  }
  function sync() {
    if (!nav) return;
    var k = activeKey(), g = groupOf(k);
    nav.querySelectorAll('.ds-nav-item').forEach(function (b) {
      var grp = NAV.filter(function (x) { return x.id === b.getAttribute('data-g'); })[0];
      b.classList.toggle('on', grp === g);
      var n = grp.badge.reduce(function (s, key) { return s + cnt(key); }, 0), bd = b.querySelector('.ds-badge');
      if (bd) { bd.textContent = n > 999 ? '999+' : n; bd.style.display = n ? '' : 'none'; }
    });
    renderSub(g, k);
  }
  function build() {
    if (!document.querySelector('.tabs-bar') || (!tab('xall') && tries < 20)) { tries++; return setTimeout(build, 200); }
    nav = document.createElement('nav'); nav.className = 'ds-nav'; nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = '<div class="ds-nav-brand"><i>JD</i><span>Jaadu Diet</span></div>' + NAV.map(function (g) {
      return '<button type="button" class="ds-nav-item" data-g="' + g.id + '">' + I[g.id] + '<span>' + g.label + '</span><em class="ds-badge" style="font-style:normal"></em></button>';
    }).join('');
    document.body.appendChild(nav);
    var bar = document.querySelector('.tabs-bar');
    sub = document.createElement('div'); sub.className = 'ds-sub'; bar.parentNode.insertBefore(sub, bar.nextSibling);
    nav.addEventListener('click', function (e) {
      var b = e.target.closest('.ds-nav-item'); if (!b) return;
      var g = NAV.filter(function (x) { return x.id === b.getAttribute('data-g'); })[0], t = tab(g.tabs[0][0]);
      if (t) t.click(); sync();
    });
    sub.addEventListener('click', function (e) { var b = e.target.closest('button[data-k]'); if (!b) return; var t = tab(b.getAttribute('data-k')); if (t) t.click(); sync(); });
    document.body.classList.add('ds-nav-ready');
    new MutationObserver(sync).observe(bar, { attributes: true, subtree: true, attributeFilter: ['class'], childList: true, characterData: true });
    setInterval(sync, 2000); sync();
  }

  // Label every table cell with its column name (the phone layout shows the label above each value) and set apart the quiet destructive button.
  var pending = null;
  function decorate() {
    document.querySelectorAll('.table-wrap table').forEach(function (t) {
      var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (h) { return h.textContent.trim(); });
      t.querySelectorAll('thead th').forEach(function (th, i) { if (heads[i]) th.setAttribute('data-label', heads[i]); });
      t.querySelectorAll('tbody tr').forEach(function (tr) {
        Array.prototype.forEach.call(tr.children, function (td, i) { if (heads[i] && td.getAttribute('data-label') !== heads[i]) td.setAttribute('data-label', heads[i]); });
      });
    });
    document.querySelectorAll('.btn-group button, .xbg button').forEach(function (b) { if (/do not call/i.test(b.textContent)) b.classList.add('ds-quiet-danger'); });
  }
  new MutationObserver(function () { clearTimeout(pending); pending = setTimeout(decorate, 150); }).observe(document.body, { childList: true, subtree: true });
  decorate();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
