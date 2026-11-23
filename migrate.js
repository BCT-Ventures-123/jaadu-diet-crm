// Versioned SQL migrations. Usage:
//   node migrate.js            -> list pending migrations (dry run, changes nothing)
//   node migrate.js --apply    -> apply pending migrations, each in its own transaction
// BACK UP THE DATABASE FIRST (see README-CC.md).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  try {
    const base = await pool.query("SELECT to_regclass('public.orders_master') AS t");
    if (!base.rows[0].t) throw new Error('orders_master not found. Run "npm run setup-db" first.');

    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const pending = files.filter(f => !done.has(f));

    if (!pending.length) { console.log('No pending migrations.'); return; }
    console.log('Pending migrations:\n  ' + pending.join('\n  '));
    if (!apply) {
      console.log('\nDry run only. Take a database backup, then re-run with --apply.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('Applied ' + file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed and was rolled back: ${err.message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  const parts = [e.name, e.code, e.message].filter(Boolean);
  const inner = (e.errors || []).map(x => [x.code, x.address && (x.address + ':' + x.port), x.message].filter(Boolean).join(' ')).join(' | ');
  console.error('Migration failed:', parts.join(' / ') || String(e), inner ? '[' + inner + ']' : '');
  process.exit(1);
});
