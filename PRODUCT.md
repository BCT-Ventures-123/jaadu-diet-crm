# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Call-centre agents (outsourced team):** call new COD customers from a lead queue and record the result (confirm, cancel, did not pick up, callback, fix address, wrong number, escalate). Confirmed: they work on both phones and laptops.
- **Aman (in-house team):** works repeat customers, duplicates, delivery follow-up (pre/post delivery, NDR recovery) and leads handed over when the call centre could not reach the customer. Same devices.
- **Owner / manager (admin):** checks that every order gets a first call by 2 PM (same-day dispatch cut-off), reaches 95% connectivity and 90% shipped, and watches the team, refunds, couriers and data accuracy. Confirmed: needs one trustworthy report, not many.

## Product Purpose

An operations CRM for a D2C tea brand (Jaadu Diet, Arjuna tea) that sells on Shopify, mostly cash on delivery. It exists so every COD order is confirmed by a real conversation, quickly, before it ships. Success: every order placed before 1 PM has a first call by 2 PM, connectivity reaches 95%, confirmed orders ship, and cancellations and returns fall.

## Positioning

A COD-confirmation workflow built around speed to first call: the queue decides who to call next and why, a presence-aware autopilot routes leads to the team that is actually working, and one report definition covers WhatsApp, IVR and manual calls together.

## Operating Context

- Orders arrive from Shopify; confirmation happens by WhatsApp (Meta), IVR (after 6 PM), the call centre and Aman. The Google Sheet sync brings WhatsApp and IVR outcomes into the CRM.
- Calling inside this CRM started 21 Oct 2026; earlier history lives in the owner's sheet.
- Same-day dispatch cut-off is 2 PM India time. Dates and hours are India time.
- Roles: agent (call centre), aman, admin. Pages today: login, call-centre CRM, Aman CRM, admin (Daily report, Scoreboard, Funnel, Channels, Refunds, Courier money, Agents, Call log and others).
- Server: Node/Express with PostgreSQL on Railway; vanilla HTML, CSS and JavaScript pages; no framework or build step. Deploys from the GitHub `master` branch.

## Capabilities and Constraints

- Lead queue with priority and reasons (lib/queue.js), disposition modal, bulk Lead Workbench, history drawer, short-address fixing, prepaid payment links, Shopify sync (tags, cancel, address).
- Reports share one engine (lib/funnel.js, lib/report2.js); Excel export with the same numbers.
- Constraints: stay vanilla JS/CSS (no new build tooling); every number must say what it counts; test orders, orders under Rs 350, non-tea products and prepaid orders are excluded from the COD funnel; no secrets in the UI.
- Confirmed requirements for the redesign: agents use both phones and laptops; text must be larger (nothing under 12px) with larger tap targets; labels in English; start with the work screens (Aman and call centre) and the shared design system, then manager pages.
- Undecided: whether to add Hindi labels later; final tab structure for Aman and manager pages.

## Brand Commitments

- Names: Jaadu Diet (company), Arjuna tea (products). Existing UI is dark with an orange/amber brand accent and the Inter typeface; whether to keep these is a redesign decision, not a commitment.

## Evidence on Hand

- Working screens to use as the incumbent: public/aman-crm.html, cc-crm.html, admin.html, login.html, with shared crm-ext.js, funnel-ui.js, report-ui.js, scoreboard-ui.js.
- Owner's reference report layout (overview, by hour, timing, attempts, journey, daily) already implemented on the Daily report.
- Measured problems on the Aman page: 22 distinct font sizes, about 500 text items under 11px, 9 tabs, first lead about 440px from the top, an 11-column lead table that does not fit a phone.
- No customer testimonials, brand photography or logo files were provided; none should be invented.

## Product Principles

1. **One number, one meaning.** Every figure states what it counts and matches the list behind it.
2. **The next action is always obvious.** The agent never has to hunt for the next lead or the right button.
3. **Phone and laptop are equals.** A lead can be worked completely with a thumb.
4. **Calm under load.** Dense data stays scannable; colour carries meaning (good, bad, needs attention), not decoration.
5. **Automate the routine.** The system routes, nudges and records so the owner does not have to.

## Accessibility & Inclusion

- Larger text: minimum 12px body-level text, comfortable tap targets for phones.
- English labels. Hindi labels may come later.
- Do not rely on colour alone to show status.
