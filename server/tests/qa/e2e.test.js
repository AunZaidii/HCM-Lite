// §14 End-to-end demo walk-through on a fresh, empty database, entirely through the API (the brief's 5-minute script).
// The LLM provider is mocked so the AI steps are deterministic. Schema: qa_e2e.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { qa } from './helpers.js';

vi.mock('../../src/modules/ai/provider.js', async (orig) => ({ ...(await orig()), chatCompletion: vi.fn() }));

const LONG = 600_000;
let ctx; let provider;
const S = {};
const say = (content) => ({ role: 'assistant', content });
const toolCall = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

beforeAll(async () => {
  ctx = await qa('qa_e2e', { baseline: false, clock: '2026-10-26T08:50', aiKey: 'test-key' });
  provider = await import('../../src/modules/ai/provider.js');
}, LONG);
afterAll(async () => ctx?.close());

describe('§14 end-to-end', () => {
  it('E2E-01 fresh install: first-run setup creates the company and Admin', async () => {
    expect((await ctx.api.get('/api/setup/status')).body).toMatchObject({ setupComplete: false, adminExists: false });
    const res = await ctx.api.post('/api/setup').send({ companyName: 'Demo Co', admin: { fullName: 'Ada Admin', email: 'admin@demo.co', password: 'Admin1234' } });
    expect(res.status).toBe(201);
    S.A = ctx.as(res.body.token);
  });

  it('E2E-02 Admin sets hours, grace, location, a department and leave types, and creates an HR login', async () => {
    expect((await S.A.put('/settings', { officeStart: '09:00', graceMinutes: 15, officeLat: 24.8607, officeLng: 67.0011, officeRadiusM: 150 })).status).toBe(200);
    S.dept = (await S.A.post('/departments', { name: 'Engineering', code: 'ENG' })).body.id;
    expect((await S.A.post('/leave-types/standard')).status).toBe(201);
    const hr = await S.A.post('/users', { role: 'hr', employeeCode: 'HR-001', fullName: 'Hina HR', email: 'hr@demo.co', departmentId: S.dept, joinDate: '2026-01-01', basicSalary: 80000 });
    expect(hr.status).toBe(201);
    S.hrTemp = hr.body.tempPassword;
  });

  it('E2E-03 HR signs in, changes the temporary password, registers employees with salary', async () => {
    S.H = ctx.as(await ctx.firstLogin('hr@demo.co', S.hrTemp, 'Hrpass123'));
    for (const [code, name, email, basic] of [['EMP-001', 'Ali Khan', 'ali@demo.co', 100000], ['EMP-002', 'Sara Ahmed', 'sara@demo.co', 80000]]) {
      const res = await S.H.post('/employees', { employeeCode: code, fullName: name, email, departmentId: S.dept, joinDate: '2026-10-01', basicSalary: basic });
      expect(res.status).toBe(201);
      S[code] = res.body;
    }
  });

  it('E2E-04 an employee signs in, changes the password and checks in', async () => {
    const t = await ctx.login('ali@demo.co', S['EMP-001'].tempPassword);
    expect((await ctx.as(t).get('/attendance/today')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    S.E = ctx.as(await ctx.firstLogin('ali@demo.co', S['EMP-001'].tempPassword, 'Alipass123'));
    S.sara = ctx.as(await ctx.firstLogin('sara@demo.co', S['EMP-002'].tempPassword, 'Sarapass123'));
    const res = await S.E.post('/attendance/check-in');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('present'); // 08:50 < 09:15
  });

  it('E2E-05 smart leave in plain words pre-fills the form; the employee confirms it', async () => {
    provider.chatCompletion.mockReset().mockResolvedValueOnce(say('{"type":"CASUAL","start":"2026-11-02","end":"2026-11-03","reason":"Sister\'s wedding"}'));
    const draft = await S.E.post('/ai/smart-leave', { text: "I need next Monday and Tuesday off for my sister's wedding" });
    expect(draft.body).toMatchObject({ ok: true, aiGenerated: true, draft: { type: 'CASUAL', start: '2026-11-02', end: '2026-11-03', workingDays: 2 } });
    expect(await ctx.count('leave_requests')).toBe(0); // the AI never saves
    const d = draft.body.draft;
    const res = await S.E.post('/leave/requests', { leaveTypeId: d.leaveTypeId, startDate: d.start, endDate: d.end, reason: d.reason, source: 'smart' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', days: 2, source: 'smart' });
    S.leave = res.body;
  });

  it('E2E-06 HR approves with a comment; employee notified; balance updated', async () => {
    const res = await S.H.post(`/leave/requests/${S.leave.id}/approve`, { comment: 'Congratulations' });
    expect(res.body.status).toBe('approved');
    expect((await S.E.get('/notifications')).body.items.some((n) => n.type === 'LEAVE_DECIDED' && n.body === 'Congratulations')).toBe(true);
    expect((await S.E.get('/leave/balance')).body.find((b) => b.code === 'CASUAL')).toMatchObject({ approved: 2, remaining: 8 });
  });

  it('E2E-07 HR dashboard numbers match; Summarize uses only KPI numbers; "who is on leave" matches records', async () => {
    ctx.at('2026-11-02T11:00');
    const dash = (await S.H.get('/analytics/hr')).body;
    expect(dash.kpis).toMatchObject({ headcount: 3, onLeaveToday: 1 });
    provider.chatCompletion.mockReset().mockResolvedValueOnce(say(JSON.stringify({ bullets: [`Headcount is ${dash.kpis.headcount}.`, `${dash.kpis.onLeaveToday} employee is on leave today.`, `${dash.kpis.pendingApprovals} approvals are pending.`] })));
    const sum = await S.H.post('/ai/summary', { dashboard: 'hr' });
    expect(sum.body.bullets).toHaveLength(3);
    const kpiJson = provider.chatCompletion.mock.calls[0][0].messages.at(-1).content;
    expect(JSON.parse(kpiJson).kpis.headcount).toBe(3);
    provider.chatCompletion.mockReset()
      .mockResolvedValueOnce(toolCall('get_leave_summary', { date: '2026-11-02' }))
      .mockImplementationOnce(async ({ messages }) => say(`On leave: ${JSON.parse(messages.at(-1).content).people.map((p) => p.name).join(', ')}`));
    const chat = await S.H.post('/ai/chat', { messages: [{ role: 'user', content: 'Who is on leave today?' }] });
    expect(chat.body.answer).toBe('On leave: Ali Khan');
    expect(chat.body.toolsUsed).toEqual(['get_leave_summary']);
  });

  it('E2E-08 HR creates the payroll draft; Admin finalizes; run is locked', async () => {
    ctx.at('2026-11-02T12:00');
    const run = await S.H.post('/payroll/runs', { month: '2026-10' });
    expect(run.status).toBe(201);
    expect(run.body.employeeCount).toBe(3);
    expect((await S.H.post(`/payroll/runs/${run.body.id}/finalize`)).status).toBe(403);
    expect((await S.A.post(`/payroll/runs/${run.body.id}/finalize`)).body.status).toBe('finalized');
    expect((await S.H.post(`/payroll/runs/${run.body.id}/recalculate`)).status).toBe(423);
    S.run = run.body;
  });

  it('E2E-09 the employee downloads their payslip PDF', async () => {
    const slips = (await S.E.get('/payslips')).body;
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ month: '2026-10', gross: 150000 });
    const pdf = await S.E.get(`/payslips/${slips[0].id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/payslip-EMP-001-2026-10\.pdf/);
  });

  it("E2E-10 the employee asks for a colleague's salary: refused, and the tools cannot reveal it", async () => {
    provider.chatCompletion.mockReset()
      .mockResolvedValueOnce(toolCall('get_payroll_summary', { month: '2026-10' }))
      .mockImplementationOnce(async ({ messages }) => say(messages.at(-1).content));
    const res = await S.E.post('/ai/chat', { messages: [{ role: 'user', content: "What is Sara's salary?" }] });
    const toolResult = JSON.parse(res.body.answer);
    expect(Object.keys(toolResult)).toEqual(['myPayslips']); // own payslips only
    expect(JSON.stringify(toolResult)).not.toMatch(/Sara/);
    const offered = provider.chatCompletion.mock.calls[0][0].tools.map((t) => t.function.name);
    expect(offered).not.toContain('get_headcount');
  });

  it('E2E-11 Admin opens the audit log: every step is recorded with before/after', async () => {
    const actions = (await S.A.get('/audit', { page: 1 })).body.items.map((a) => a.action);
    for (const a of ['SETUP_COMPLETED', 'SETTINGS_UPDATED', 'DEPARTMENT_CREATED', 'LEAVE_TYPE_CREATED', 'USER_CREATED', 'PASSWORD_CHANGED', 'EMPLOYEE_CREATED',
      'CHECK_IN', 'LEAVE_APPLIED', 'LEAVE_APPROVED', 'PAYROLL_DRAFT_CREATED', 'PAYROLL_FINALIZED']) expect(actions).toContain(a);
    const approved = (await S.A.get('/audit', { action: 'LEAVE_APPROVED' })).body.items[0];
    expect(approved.before.status).toBe('pending');
    expect(approved.after.status).toBe('approved');
  });
});
