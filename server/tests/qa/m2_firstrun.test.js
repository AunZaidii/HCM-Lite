// QA — M2 first-run setup (HCM_Lite_Test_Plan.md §4.1, M2-01..M2-06). Empty install in schema qa_m2fresh.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qa } from './helpers.js';

let ctx;
let ip = 0;
const login = (email, password) => ctx.api.post('/api/auth/login').set('X-Forwarded-For', `10.2.0.${++ip}`).send({ email, password });

beforeAll(async () => { ctx = await qa('qa_m2fresh', { baseline: false }); });
afterAll(async () => ctx?.close());

describe('M2 first-run setup', () => {
  it('M2-01 fresh install reports setup not complete and blocks the rest of the API', async () => {
    const status = await ctx.api.get('/api/setup/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ setupComplete: false, adminExists: false });
    const blocked = await login('admin@test.co', 'Admin1234');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SETUP_REQUIRED');
    expect(await ctx.count('users')).toBe(0);
  });

  it('M2-03 setup validation: blank company, invalid email, weak password are rejected; nothing created', async () => {
    const cases = [
      { companyName: '', admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'Admin1234' } },
      { companyName: 'QA Co', admin: { fullName: 'Ada Admin', email: 'not-an-email', password: 'Admin1234' } },
      { companyName: 'QA Co', admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'weak' } },
      { companyName: 'QA Co', admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'onlyletters' } },
      { companyName: 'QA Co' }, // no admin and none from env
    ];
    for (const body of cases) {
      const res = await ctx.api.post('/api/setup').send(body);
      expect([400, 422]).toContain(res.status);
      expect(res.body.error.message).toBeTruthy();
    }
    expect(await ctx.count('users')).toBe(0);
    expect(await ctx.count('company_settings')).toBe(0);
  });

  it('M2-02 complete setup creates company + Admin; Admin can sign in', async () => {
    const res = await ctx.api.post('/api/setup').send({ companyName: 'QA Co', admin: { fullName: 'Ada Admin', email: 'admin@test.co', password: 'Admin1234' } });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.token).toBeTruthy(); // signs the Admin in directly (plan says "redirected to login" — UI detail)
    expect((await ctx.api.get('/api/setup/status')).body.setupComplete).toBe(true);
    const signIn = await login('admin@test.co', 'Admin1234');
    expect(signIn.status).toBe(200);
    expect(await ctx.count('company_settings')).toBe(1);
    expect(await ctx.count('users', "role = 'admin'")).toBe(1);
  });

  it('M2-04 setup locks after use: a second call is blocked and creates no second Admin', async () => {
    const res = await ctx.api.post('/api/setup').send({ companyName: 'Evil Co', admin: { fullName: 'Evil Admin', email: 'evil@test.co', password: 'Evil12345' } });
    expect([403, 409]).toContain(res.status);
    expect(res.body.error.code).toBe('SETUP_ALREADY_DONE');
    expect(await ctx.count('users', "role = 'admin'")).toBe(1);
    expect(await ctx.count('users', "email = 'evil@test.co'")).toBe(0);
    expect((await ctx.db.one('select company_name from company_settings')).companyName).toBe('QA Co');
  });

  it('M2-05 env-file Admin: ADMIN_EMAIL/ADMIN_PASSWORD create the Admin on a fresh database; setup then only asks for company', async () => {
    const { applySchema } = await import('../../scripts/schema.js');
    await applySchema({ reset: true });
    ctx.env.ADMIN_EMAIL = 'envadmin@test.co';
    ctx.env.ADMIN_PASSWORD = 'EnvAdmin123';
    const { bootstrapEnvAdmin } = await import('../../src/modules/auth.routes.js');
    await bootstrapEnvAdmin();
    expect(await ctx.count('users', "role = 'admin' and email = 'envadmin@test.co'")).toBe(1);
    const status = await ctx.api.get('/api/setup/status');
    expect(status.body).toMatchObject({ setupComplete: false, adminExists: true, adminFromEnv: true });
    const setup = await ctx.api.post('/api/setup').send({ companyName: 'Env Co' });
    expect(setup.status).toBe(201);
    const signIn = await login('envadmin@test.co', 'EnvAdmin123');
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.role).toBe('admin');
  });

  it('M2-06 restart after setup: no duplicate Admin or company; data intact', async () => {
    const { bootstrapEnvAdmin } = await import('../../src/modules/auth.routes.js');
    await bootstrapEnvAdmin(); // simulates a server restart (runs on every boot)
    await bootstrapEnvAdmin();
    expect(await ctx.count('users', "role = 'admin'")).toBe(1);
    expect(await ctx.count('company_settings')).toBe(1);
    expect((await ctx.db.one('select company_name from company_settings')).companyName).toBe('Env Co');
    expect((await login('envadmin@test.co', 'EnvAdmin123')).status).toBe(200);
    ctx.env.ADMIN_EMAIL = '';
    ctx.env.ADMIN_PASSWORD = '';
  });
});
