require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connected to database');

    console.log('Running schema.sql...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await client.query(schema);
    console.log('Schema created successfully');

    console.log('Running views.sql...');
    const views = fs.readFileSync(path.join(__dirname, 'views.sql'), 'utf-8');
    await client.query(views);
    console.log('Views created successfully');

    const tableCount = await client.query(`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const viewCount = await client.query(`
      SELECT COUNT(*) FROM information_schema.views
      WHERE table_schema = 'public'
    `);
    console.log(`\nSetup complete: ${tableCount.rows[0].count} tables, ${viewCount.rows[0].count} views`);

  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
