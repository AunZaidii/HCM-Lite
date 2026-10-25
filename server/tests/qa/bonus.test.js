// §13 Bonus features at API level (HCM_Lite_Test_Plan.md): camera check-in rules decided by the server, face match +
// liveness, admin office location, late penalty in payroll, attrition risk, absence anomaly flags. Schema: qa_bonus.
// UI-only items (B-07 permission prompts, B-11 photo-to-camera, B-18 dark mode, B-19 PWA install) are in results/ui_live.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attend, qa, workingDays } from './helpers.js';

const LONG = 1_200_000;
const OFFICE = { lat: 24.8607, lng: 67.0011 };
const M_PER_DEG_LAT = 111_320;
const north = (m) => OFFICE.lat + m / M_PER_DEG_LAT;
let ctx; let A; let H;

beforeAll(async () => {
  ctx = await qa('qa_bonus', { clock: '2026-11-02T08:00' });
  A = ctx.as(ctx.tok.admin); H = ctx.as(ctx.tok.hr);
  // A 4th employee with an irregular pattern for the anomaly / risk checks.
  const zara = await H.post('/employees', { employeeCode: 'EMP-004', fullName: 'Zara Malik', email: 'zara@test.co', departmentId: ctx.ids.sales, joinDate: '2026-11-02', basicSalary: 60000, status: 'active' });
  ctx.emp.zara = zara.body.employee;
  ctx.tok.zara = await ctx.firstLogin('zara@test.co', zara.body.tempPassword, 'Zarapass123');
  // Same join date as Zara but a clean record, for a fair attrition-risk comparison inside the 90-day window.
  const carl = await H.post('/employees', { employeeCode: 'EMP-005', fullName: 'Carl Clean', email: 'carl@test.co', departmentId: ctx.ids.sales, joinDate: '2026-11-02', basicSalary: 60000, status: 'active' });
  ctx.emp.carl = carl.body.employee;
  ctx.tok.carl = await ctx.firstLogin('carl@test.co', carl.body.tempPassword, 'Carlpass123');

  // November 2026: 20 working days (9 Nov holiday). Ali: 3 lates (first week), Sara: 2 lates, Usman: 6 lates,
  // Zara (joined 2 Nov): absent on every Monday (2, 16, 23, 30 Nov); Carl (joined 2 Nov): perfect record.
  const days = workingDays('2026-11-01', '2026-11-30');
  const lateFor = { ali: days.slice(0, 3), sara: days.slice(0, 2), usman: days.slice(0, 6) };
  for (const d of days) {
    for (const who of ['ali', 'sara', 'usman']) await attend(ctx, ctx.tok[who], d, lateFor[who].includes(d) ? '09:30' : '09:00', '18:00');
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) await attend(ctx, ctx.tok.zara, d, '09:00', '18:00');
    await attend(ctx, ctx.tok.carl, d, '09:00', '18:00');
  }
}, LONG);
afterAll(async () => ctx?.close());

describe('13.1 Camera attendance (server decides)', () => {
  const base = { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 20, faceCount: 1 };
  const cam = (who, body) => ctx.as(ctx.tok[who]).post('/attendance/camera-check-in', body);

  it('B-02 no face is rejected and nothing is saved', async () => {
    ctx.at('2026-12-01T09:00');
    const res = await cam('ali', { ...base, faceCount: 0 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_FACE');
    expect(await ctx.count('attendance', 'employee_id = $1 and work_date = $2', [ctx.emp.ali.id, '2026-12-01'])).toBe(0);
  });

  it('B-03 more than one face is rejected', async () => {
    expect((await cam('ali', { ...base, faceCount: 2 })).body.error.code).toBe('MULTIPLE_FACES');
  });

  it('B-04 500 m away is rejected with the server-computed distance', async () => {
    const res = await cam('ali', { ...base, lat: north(500) });
    expect(res.body.error.code).toBe('OUTSIDE_RADIUS');
    expect(res.body.error.message).toMatch(/500 m from the office/);
  });

  it('B-05 radius boundary: 151 m rejected, 149 m accepted', async () => {
    expect((await cam('ali', { ...base, lat: north(151) })).body.error.code).toBe('OUTSIDE_RADIUS');
    const ok = await cam('ali', { ...base, lat: north(149) });
    expect(ok.status).toBe(201);
    expect(ok.body.distanceM).toBeLessThanOrEqual(150);
  });

  it('B-06 GPS accuracy worse than 100 m is rejected', async () => {
    expect((await cam('sara', { ...base, accuracy: 101 })).body.error.code).toBe('LOW_ACCURACY');
  });

  it('B-01 valid camera check-in is saved with source = camera and a status', async () => {
    const res = await cam('sara', base);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'camera', status: 'present' });
  });

  it('B-08 spoofed success flags with fake far-away coordinates are still rejected', async () => {
    const res = await cam('usman', { ...base, lat: 31.5204, lng: 74.3587, faceVerified: true, livenessPassed: true, distanceM: 0, status: 'present' });
    expect(res.body.error.code).toBe('OUTSIDE_RADIUS');
  });

  it('B-09 privacy: only the result is stored, never a photo', async () => {
    const cols = (await ctx.db.query("select column_name from information_schema.columns where table_schema = current_schema() and table_name in ('attendance','checkin_attempts','face_profiles')")).map((c) => c.columnName);
    expect(cols.join(',')).not.toMatch(/photo|image|picture|selfie/i);
    expect(await ctx.count('checkin_attempts')).toBeGreaterThanOrEqual(5);
  });

  it('B-10 a failed camera check falls back to an HR correction request', async () => {
    const res = await ctx.as(ctx.tok.usman).post('/attendance/corrections', { date: '2026-12-01', requestedCheckIn: '09:00', reason: 'Camera check-in failed at the gate' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  it('B-11 face match: a different person is rejected; failed liveness is rejected', async () => {
    const face = Array.from({ length: 128 }, (_, i) => Math.cos(i) / 10);
    expect((await ctx.as(ctx.tok.zara).post('/attendance/face/enroll', { descriptor: face })).status).toBe(204);
    await A.put('/settings', { faceMatchRequired: true });
    const other = face.map((v) => v + 0.1);
    expect((await cam('zara', { ...base, descriptor: other, livenessPassed: true })).body.error.code).toBe('FACE_MISMATCH');
    expect((await cam('zara', { ...base, descriptor: face, livenessPassed: false })).body.error.code).toBe('LIVENESS_FAILED');
    const ok = await cam('zara', { ...base, descriptor: face, livenessPassed: true });
    expect(ok.status).toBe(201);
    expect(ok.body.faceVerified).toBe(true);
    await A.put('/settings', { faceMatchRequired: false });
  });

  it('B-12 Admin changes office location and radius: new check-ins use the new values', async () => {
    ctx.at('2026-12-02T09:00');
    await A.put('/settings', { officeLat: 31.5204, officeLng: 74.3587, officeRadiusM: 300 });
    expect((await cam('ali', base)).body.error.code).toBe('OUTSIDE_RADIUS');
    const ok = await cam('ali', { ...base, lat: 31.5204 + 250 / M_PER_DEG_LAT, lng: 74.3587 });
    expect(ok.status).toBe(201);
    await A.put('/settings', { officeLat: OFFICE.lat, officeLng: OFFICE.lng, officeRadiusM: 150 });
  });
});

describe('13.2 Other bonus items', () => {
  let slips;
  it('B-13 late penalty: 3 lates = 0.5 day, 2 lates = 0, 6 lates = 1 day (repeats per 3)', async () => {
    await A.put('/settings', { latePenaltyEnabled: true });
    ctx.at('2026-12-03T10:00');
    const run = await H.post('/payroll/runs', { month: '2026-11' });
    expect(run.status).toBe(201);
    slips = (await A.get(`/payroll/runs/${run.body.id}`)).body.payslips;
    const by = (e) => slips.find((p) => p.employeeId === ctx.emp[e].id);
    expect(by('ali')).toMatchObject({ workingDays: 20, lateCount: 3, latePenaltyDays: 0.5, deductionAmount: 3750 });
    expect(by('sara')).toMatchObject({ lateCount: 2, latePenaltyDays: 0, deductionAmount: 0 });
    expect(by('usman')).toMatchObject({ lateCount: 6, latePenaltyDays: 1, deductionAmount: 4500 });
  });

  it('B-14 attrition risk: irregular profile scores higher than a clean record, with an explanation', async () => {
    const risk = (await A.get('/analytics/admin')).body.attritionRisk;
    const all = (await (await import('../../src/modules/analytics.service.js')).attritionRisk({}));
    const zara = all.find((r) => r.employee === 'Zara Malik');
    const carl = all.find((r) => r.employee === 'Carl Clean');
    expect(zara.score).toBeGreaterThan(carl.score);
    expect(zara.factors.join(' ')).toMatch(/absenteeism/);
    expect(risk.length).toBeGreaterThan(0);
  });

  it('B-15 absence anomaly: Monday absences are flagged; a regular pattern is not', async () => {
    const flags = (await H.get('/analytics/hr', { from: '2026-11-01', to: '2026-11-30' })).body.anomalyFlags;
    expect(flags.some((f) => f.employee === 'Zara Malik' && f.flag === 'Long-weekend pattern')).toBe(true);
    expect(flags.filter((f) => f.employee === 'Sara Ahmed')).toEqual([]);
  });
});
