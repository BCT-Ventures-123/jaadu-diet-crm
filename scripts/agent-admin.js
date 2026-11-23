// Manage call-centre logins from the command line.
//   node scripts/agent-admin.js list
//   node scripts/agent-admin.js create <username> "<Display Name>" [--admin|--aman] [--backup] [--password=...]
//   node scripts/agent-admin.js reset <username> [--password=...]
//   node scripts/agent-admin.js disable <username>
//   node scripts/agent-admin.js enable <username>
// Without --password a random one is generated and printed once. Passwords are stored hashed.
require('dotenv').config();
const { Pool } = require('pg');
const auth = require('../lib/auth');

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.length ? v.join('=') : true];
}));
const pos = args.filter(a => !a.startsWith('--'));
const [cmd, username, displayName] = pos;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  try {
    const uname = (username || '').toLowerCase();
    if (cmd === 'list') {
      const { rows } = await pool.query('SELECT username, display_name, role, is_backup, is_active, last_login_at FROM agents ORDER BY role, display_name');
      console.table(rows);
    } else if (cmd === 'create') {
      if (!/^[a-z0-9._-]{3,40}$/.test(uname) || !displayName) throw new Error('Usage: create <username> "<Display Name>"');
      const password = typeof flags.password === 'string' ? flags.password : auth.generatePassword();
      const weak = auth.checkPasswordStrength(password);
      if (weak) throw new Error(weak);
      const role = flags.admin ? 'admin' : flags.aman ? 'aman' : 'agent';
      await pool.query(
        'INSERT INTO agents (username, display_name, password_hash, role, is_backup) VALUES ($1,$2,$3,$4,$5)',
        [uname, displayName, await auth.hashPassword(password), role, !!flags.backup]);
      console.log(`Created ${uname} (${role})${flags.backup ? ' (backup)' : ''}`);
      if (typeof flags.password !== 'string') console.log(`Password (shown once): ${password}`);
    } else if (cmd === 'reset') {
      const password = typeof flags.password === 'string' ? flags.password : auth.generatePassword();
      const weak = auth.checkPasswordStrength(password);
      if (weak) throw new Error(weak);
      const r = await pool.query(
        `UPDATE agents SET password_hash = $2, token_version = token_version + 1, failed_logins = 0, locked_until = NULL, updated_at = NOW()
         WHERE username = $1`, [uname, await auth.hashPassword(password)]);
      if (!r.rowCount) throw new Error('No such agent');
      console.log(`Password reset for ${uname}; existing sessions signed out.`);
      if (typeof flags.password !== 'string') console.log(`New password (shown once): ${password}`);
    } else if (cmd === 'disable' || cmd === 'enable') {
      const r = await pool.query(
        'UPDATE agents SET is_active = $2, token_version = token_version + 1, updated_at = NOW() WHERE username = $1',
        [uname, cmd === 'enable']);
      if (!r.rowCount) throw new Error('No such agent');
      console.log(`${uname} ${cmd}d.`);
    } else {
      console.log('Commands: list | create | reset | disable | enable (see the header of this file)');
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
