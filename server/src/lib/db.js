import pg from 'pg';
import { env } from '../config/env.js';
import { isTestClock, now } from './clock.js';

// numeric/bigint as JS numbers, dates as 'YYYY-MM-DD' strings
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
});

// Idle connections can be dropped by the Supabase pooler; log and let the pool replace them instead of crashing.
pool.on('error', (err) => console.error('Postgres pool error (connection will be replaced):', err.code || err.message));

// Optional separate schema (used by the API tests so they never touch real data).
if (env.DB_SCHEMA) {
  pool.on('connect', (client) => client.query(`set search_path to "${env.DB_SCHEMA}", public, extensions`));
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export const camelize = (row) => {
  const out = {};
  for (const k of Object.keys(row)) out[camel(k)] = row[k];
  return out;
};

// Tests only: pass the frozen test clock to SQL (fn_daily_status reads hcm.now) on the same connection.
const syncTestClock = (client) => client.query("select set_config('hcm.now', $1, false)", [isTestClock() ? now().toISOString() : '']);

function runner(client) {
  return {
    async query(text, params = []) {
      if (client === pool && isTestClock()) {
        const c = await pool.connect();
        try {
          await syncTestClock(c);
          return (await c.query(text, params)).rows.map(camelize);
        } finally {
          c.release();
        }
      }
      const res = await client.query(text, params);
      return res.rows.map(camelize);
    },
    async one(text, params = []) {
      const rows = await this.query(text, params);
      return rows[0] ?? null;
    },
  };
}

export const db = runner(pool);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    if (isTestClock()) await syncTestClock(client);
    await client.query('begin');
    const result = await fn(runner(client));
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
