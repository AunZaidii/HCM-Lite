// Sanity check for the QA harness itself: fresh schema, baseline via API, frozen clock reaches JS and SQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

let ctx;
beforeAll(async () => { ctx = await qa('qa_m0'); });
afterAll(async () => ctx?.close());

describe('QA harness', () => {
  it('builds the §2 baseline through the API', async () => {
    expect(await ctx.count('employees')).toBe(4);
    expect(await ctx.count('users')).toBe(5);
    expect(await ctx.count('departments')).toBe(2);
    expect(await ctx.count('designations')).toBe(3);
    expect(await ctx.count('leave_types')).toBe(4);
    expect(await ctx.count('holidays')).toBe(1);
  });

  it('frozen clock is used by JS and by SQL (fn_daily_status)', async () => {
    ctx.at('2026-11-03T09:20');
    const today = await ctx.as(ctx.tok.ali).get('/attendance/today');
    expect(today.body.date).toBe('2026-11-03');
    expect(today.body.localTime).toBe('09:20:00');
    const sql = await ctx.db.one("select max(work_date) as d from fn_daily_status('2026-11-01','2026-11-30') where status <> 'upcoming'");
    expect(sql.d).toBe('2026-11-03');
  });
});
