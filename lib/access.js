// Who may open which page. admin: everything. aman: Aman CRM + call-centre CRM. agent: call-centre CRM only.
const PAGES = {
  '/admin.html': ['admin'],
  '/index.html': ['admin'],
  '/aman-crm.html': ['admin', 'aman'],
  '/cc-crm.html': ['admin', 'aman', 'agent'],
};
const HOME = { admin: '/admin.html', aman: '/aman-crm.html', agent: '/cc-crm.html' };

const normalize = (p) => (p === '/' ? '/index.html' : p);
const isGuardedPage = (p) => Object.prototype.hasOwnProperty.call(PAGES, normalize(p));
const canOpen = (role, p) => isGuardedPage(p) && PAGES[normalize(p)].includes(role);
const homeFor = (role) => HOME[role] || '/login.html';

module.exports = { PAGES, isGuardedPage, canOpen, homeFor };
