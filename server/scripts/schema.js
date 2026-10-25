import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { pool } from '../src/lib/db.js';

export { pool };

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const TABLES = `ai_logs, audit_logs, notifications, announcements, payslips, payroll_runs, leave_requests, attendance_corrections,
  checkin_attempts, face_profiles, attendance, holidays, leave_types, salary_structures, employees, designations, departments,
  users, company_settings`;

export async function applySchema({ reset = false, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    if (env.DB_SCHEMA) {
      if (reset) await client.query(`drop schema if exists "${env.DB_SCHEMA}" cascade`);
      await client.query(`create schema if not exists "${env.DB_SCHEMA}"`);
      await client.query(`set search_path to "${env.DB_SCHEMA}", public, extensions`);
    } else if (reset) {
      log('Resetting: dropping all HCM Lite tables...');
      await client.query(`drop table if exists ${TABLES} cascade`);
    }
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      log(`applied ${file}${env.DB_SCHEMA ? ` (schema ${env.DB_SCHEMA})` : ''}`);
    }
  } finally {
    client.release();
  }
}
