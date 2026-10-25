// Applies sql/*.sql in order. Idempotent, so it runs on every deploy.
// Usage: npm run db:setup   (create/upgrade schema)
//        npm run db:reset   (DROP all app tables first: wipes all data — use to start judging from an empty install)
import { applySchema, pool } from './schema.js';

await applySchema({ reset: process.argv.includes('--reset'), log: console.log });
await pool.end();
console.log('Database ready.');
