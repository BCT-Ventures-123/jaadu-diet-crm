# Call-centre features: setup and operations

## 1. Environment variables (set in Railway, never in the repo)

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Required. Long random string used to sign login cookies. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Creates the Rs 599 prepaid payment links. |
| `RAZORPAY_WEBHOOK_SECRET` | Required for `/webhook/razorpay` (returns 503 if unset). |
| `SESSION_HOURS` | Optional, default 12. |
| `PREPAID_LINK_EXPIRY_HOURS`, `PREPAID_LINK_SMS` | Optional. |

## 2. Back up, then migrate

Back up first (either way):

```bash
pg_dump "$DATABASE_URL" > backup_before_cc.sql
```

or use Railway > Postgres > Backups > Create backup.

Then:

```bash
npm run migrate          # dry run: lists pending migrations only
npm run migrate:apply    # applies migrations/001_cc_features.sql
```

The migration is additive (new tables/columns/views); it does not drop or rewrite existing data.

## 3. Create the first admin and agents

```bash
node scripts/agent-admin.js create admin "Admin" --admin
```

The generated password is printed once. After that, use `/admin.html` > Agents to create agents
(plus a backup agent), disable/enable them, and reset passwords. Disabling takes effect on the
agent's next request.

## 4. Razorpay webhook

Razorpay Dashboard > Settings > Webhooks > add `https://<your-domain>/webhook/razorpay`,
secret = `RAZORPAY_WEBHOOK_SECRET`, events: `payment_link.paid` and `payment.captured`.
Only a paid webhook marks the order Converted to Prepaid and credits the Rs 10 incentive.

### Shopify sync after payment

When Razorpay confirms a payment, the CRM (1) converts the order to Prepaid, (2) records a Razorpay
payment on the Shopify order so it shows Paid, adds the tag `prepaid-razorpay` and a note, and
(3) writes `done` to the COD_Confirmations sheet. Needs `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`
(with `write_orders`) and `SHOPIFY_API_VERSION`. `SHOPIFY_PREPAID_MODE=full` (default) marks the
whole order paid and notes the waived COD fee; `exact` records only the amount received.
Shopify orders that are cancelled or already fulfilled are never touched. The result is stored on the
order (`shopify_prepaid_sync`). Retry or preview with:

```bash
node scripts/shopify-sync.js --failed --dry-run
node scripts/shopify-sync.js --failed
node scripts/shopify-sync.js "#22974" --dry-run
```

Aman and admin can also send payment links (any COD order); the Rs incentive is only for call-centre agents.

## 5. Pages and access

- Roles: `agent` (call centre), `aman` (Aman), `admin` (manager). Create with `agent-admin.js create <user> "<Name>" [--aman|--admin]` or in Admin > Agents.
- `/cc-crm.html`: any logged-in role.
- `/aman-crm.html` and `/api/aman|lead|ndr|refund|order|kpi`: `aman` and `admin` only.
- `/admin.html`, `/` (portal), `/api/reports/*`, `/api/admin/*`, `/api/logistics|inventory|refunds`: `admin` only.
- Pages redirect to `/login.html` when not signed in, and to the user's own home page when the role is not allowed.
- Migration `002_aman_role.sql` adds the `aman` role and moves the existing `aman` login onto it.

## 6. Tuning

- `lib/config.js`: DNP gap (90 min), daily min/max attempts (3/5), follow-up days (7), targets (95% / 5%), incentive, prepaid amount.
- `lib/riskConfig.js`: all risk-score weights and thresholds.

## 7. Tests

```bash
npm test
```
