// Runs the whole CRM locally on an embedded throw-away Postgres. Never touches production.
//   npm run local          -> start DB (data kept in .localdb), apply schema + migration, seed demo data, start server
//   npm run local -- --reset   -> wipe the local DB first
// Local-only logins (not real credentials): admin / admin-local-123, agent1 / agent1-local-123
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.localdb');
const DB_PORT = 54329;
const APP_PORT = process.env.PORT || 3000;
const URL = `postgres://postgres:postgres@localhost:${DB_PORT}/jaadu_local`;

async function main() {
  if (process.argv.includes('--reset')) fs.rmSync(DATA, { recursive: true, force: true });
  const fresh = !fs.existsSync(DATA);

  const pg = new EmbeddedPostgres({ databaseDir: DATA, user: 'postgres', password: 'postgres', port: DB_PORT, persistent: true });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('jaadu_local');
  console.log(`Local Postgres running on port ${DB_PORT}`);

  // Child processes inherit this env. Blank values stop dotenv from loading production keys.
  const env = {
    ...process.env,
    DATABASE_URL: URL, NODE_ENV: 'development', PORT: String(APP_PORT),
    SESSION_SECRET: 'local-dev-only-session-secret-not-for-production',
    RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', RAZORPAY_WEBHOOK_SECRET: '',
    GOOGLE_SERVICE_ACCOUNT_KEY_JSON: '', GOOGLE_SERVICE_ACCOUNT_FILE: '', GOOGLE_SHEET_ID: '',
    SHOPIFY_ACCESS_TOKEN: '', SHOPIFY_WEBHOOK_SECRET: '',
    SHIPROCKET_EMAIL: '', SHIPROCKET_PASSWORD: '', SHIPROCKET_WEBHOOK_TOKEN: '', CALLYZER_API_KEY: '', CALLYZER_BASE_URL: '',
  };
  const run = (args) => new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    p.on('exit', c => c === 0 ? res() : rej(new Error(args.join(' ') + ' exited ' + c)));
  });

  if (fresh) await run(['setup_db.js']);
  await run(['migrate.js', '--apply']);

  const c = new Client({ connectionString: URL });
  await c.connect();
  const agents = (await c.query('SELECT COUNT(*)::int n FROM agents')).rows[0].n;
  if (!agents) {
    await run(['scripts/agent-admin.js', 'create', 'admin', 'Local Admin', '--admin', '--password=admin-local-123']);
    await run(['scripts/agent-admin.js', 'create', 'agent1', 'Agent One', '--password=agent1-local-123']);
    await run(['scripts/agent-admin.js', 'create', 'aman', 'Aman', '--aman', '--password=aman-local-123']);
  }
  const orders = (await c.query('SELECT COUNT(*)::int n FROM orders_master')).rows[0].n;
  if (!orders) await seed(c);
  await c.end();

  console.log(`\nCRM running at http://localhost:${APP_PORT}`);
  console.log('Call centre: /cc-crm.html   Admin: /admin.html   Aman: /aman-crm.html');
  console.log('Local logins: admin / admin-local-123   agent1 / agent1-local-123\n');
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });
  const stop = async () => { server.kill(); await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('exit', stop);
}

async function seed(c) {
  const rows = [
    ['Riya Sharma', '9811100001', '110001', 'Flat 12, near City Mall, Main Road', 599, 'CC'],
    ['Amit Verma', '9811100002', '560001', 'H-4', 1299, 'CC'],
    ['Sunita Rao', '9811100003', '400001', '22 Lake View Apartments, opp. Metro Station', 599, 'CC'],
    ['Karan Singh', '1234567890', '302001', 'abc', 2499, 'CC'],
    ['Repeat Buyer', '9811100005', '110001', 'House 9, Sector 4, near school', 599, 'CC'],
    ['Repeat Buyer', '9811100005', '110001', 'House 9, Sector 4, near school', 599, 'CC'],
  ];
  let i = 0;
  for (const [name, phone, zip, addr, price, to] of rows) {
    i++;
    await c.query(
      `INSERT INTO orders_master (shopify_order_id, order_name, customer_name, customer_phone, shipping_zip, shipping_address1,
         shipping_city, total_price, payment_method, assigned_to, confirmation_status, order_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Delhi',$7,'COD',$8,'pending','new', NOW() - ($9 || ' minutes')::interval)`,
      [9000000 + i, `#LOCAL${i}`, name, phone, zip, addr, price, to, String((rows.length - i) * 20 + 10)]);
  }
  console.log(`Seeded ${rows.length} demo orders.`);
}

main().catch(e => { console.error(e); process.exit(1); });
