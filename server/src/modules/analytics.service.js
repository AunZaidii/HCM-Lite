// Every dashboard number comes from SQL aggregation here. Dashboards, AI tools and AI summaries all call these
// functions, so the assistant always reports the same numbers as the dashboard.
import { db } from '../lib/db.js';
import { addDays, todayLocal } from '../lib/time.js';

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function normalizeRange({ from, to } = {}) {
  const today = todayLocal();
  return { from: from || `${today.slice(0, 7)}-01`, to: to && to < today ? to : today };
}

// Active + probation employees employed on the date (leavers count until their exit date).
export async function headcount({ asOf = todayLocal(), departmentId = null } = {}) {
  const row = await db.one(
    `select count(*)::int as total,
            count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status = 'probation')::int as probation
     from employees where join_date <= $1 and (exit_date is null or exit_date >= $1) and exists (select 1 from users u where u.id = employees.user_id and u.is_active)
       and ($2::uuid is null or department_id = $2)`, [asOf, departmentId]);
  return row;
}

export async function headcountByDepartment(asOf = todayLocal()) {
  return db.query(
    `select d.id as department_id, d.name as department, count(e.id)::int as headcount
     from departments d left join employees e on e.department_id = d.id and e.join_date <= $1 and (e.exit_date is null or e.exit_date >= $1) and exists (select 1 from users u where u.id = e.user_id and u.is_active)
     group by d.id order by d.name`, [asOf]);
}

// Attendance rate = (present + late + missing_checkout + 0.5 x half_day) / (working-day records - on_leave)
export async function attendanceSummary({ from, to, departmentId = null, employeeId = null }) {
  const r = await db.one(
    `select count(*) filter (where status = 'present')::int as present,
            count(*) filter (where status = 'late')::int as late,
            count(*) filter (where status = 'half_day')::int as half_day,
            count(*) filter (where status = 'missing_checkout')::int as missing_checkout,
            count(*) filter (where status = 'absent')::int as absent,
            count(*) filter (where status = 'on_leave')::int as on_leave,
            count(*) filter (where is_late)::int as late_arrivals,
            count(*)::int as working_day_records
     from fn_daily_status($1::date, $2::date, $3::uuid, $4::uuid)
     where is_working_day and status not in ('upcoming','not_checked_in')`, [from, to, departmentId, employeeId]);
  const attended = r.present + r.late + r.missingCheckout + 0.5 * r.halfDay;
  return {
    from, to, ...r,
    attendanceRate: pct(attended, r.workingDayRecords - r.onLeave),
    latePct: pct(r.late, r.present + r.late),
    absenteeismPct: pct(r.absent, r.workingDayRecords - r.onLeave),
  };
}

export async function attendanceTrend({ from, to, departmentId = null }) {
  const rows = await db.query(
    `select work_date as date,
            count(*) filter (where status in ('present','late','missing_checkout'))::float
              + 0.5 * count(*) filter (where status = 'half_day') as attended,
            count(*) filter (where status <> 'on_leave')::int as expected,
            count(*) filter (where status = 'late')::int as late,
            count(*) filter (where status = 'absent')::int as absent
     from fn_daily_status($1::date, $2::date, $3::uuid, null)
     where is_working_day and status not in ('upcoming','not_checked_in')
     group by work_date order by work_date`, [from, to, departmentId]);
  return rows.map((r) => ({ date: r.date, rate: pct(r.attended, r.expected), late: r.late, absent: r.absent }));
}

export async function absenteeismByDepartment({ from, to, departmentId = null }) {
  const rows = await db.query(
    `select d.name as department,
            count(*) filter (where s.status = 'absent')::int as absent,
            count(*) filter (where s.status = 'late')::int as late,
            count(*) filter (where s.status in ('present','late'))::int as on_time_or_late,
            (count(*) - count(*) filter (where s.status = 'on_leave'))::int as expected
     from fn_daily_status($1::date, $2::date, $3::uuid, null) s join departments d on d.id = s.department_id
     where s.is_working_day and s.status not in ('upcoming','not_checked_in')
     group by d.name order by d.name`, [from, to, departmentId]);
  return rows.map((r) => ({ ...r, absenteeismPct: pct(r.absent, r.expected), latePct: pct(r.late, r.onTimeOrLate) }));
}

// Late arrivals use is_late, so a late arrival that became a half day still counts.
export async function lateComers({ from, to, departmentId = null, limit = 5 }) {
  return db.query(
    `select e.id as employee_id, e.full_name, e.employee_code, d.name as department, count(*)::int as late_count
     from fn_daily_status($1::date, $2::date, $3::uuid, null) s
     join employees e on e.id = s.employee_id join departments d on d.id = e.department_id
     where s.is_late group by e.id, d.name order by late_count desc, e.full_name limit $4`, [from, to, departmentId, limit]);
}

export async function leaveByType({ from, to, departmentId = null }) {
  return db.query(
    `select t.name as leave_type, count(*)::int as days
     from fn_daily_status($1::date, $2::date, $3::uuid, null) s join leave_types t on t.id = s.leave_type_id
     where s.status = 'on_leave' group by t.name order by t.name`, [from, to, departmentId]);
}

// Approved days / (quota x headcount) per type and department for the leave year.
export async function leaveUtilization({ year = Number(todayLocal().slice(0, 4)), departmentId = null } = {}) {
  return db.query(
    `with hc as (
       select department_id, count(*)::int as n from employees
       where status in ('active','probation') and exists (select 1 from users u where u.id = employees.user_id and u.is_active) and ($2::uuid is null or department_id = $2) group by department_id)
     select t.name as leave_type, d.name as department, t.yearly_quota as quota, hc.n as headcount,
            coalesce(sum(l.days), 0)::float as approved_days,
            case when t.yearly_quota > 0 then round(coalesce(sum(l.days),0) / (t.yearly_quota * hc.n) * 100, 1) end::float as utilization_pct
     from hc join departments d on d.id = hc.department_id cross join leave_types t
     left join leave_requests l on l.leave_type_id = t.id and l.status = 'approved' and extract(year from l.start_date) = $1
          and l.employee_id in (select id from employees where department_id = hc.department_id)
     where t.is_active group by t.name, t.yearly_quota, d.name, hc.n order by d.name, t.name`, [year, departmentId]);
}

export async function pendingApprovals() {
  return db.one(
    `select (select count(*) from leave_requests where status = 'pending')::int as leave,
            (select count(*) from attendance_corrections where status = 'pending')::int as corrections`);
}

// Attrition % = exits in period / average headcount x 100
export async function attrition({ from, to, departmentId = null }) {
  const start = await headcount({ asOf: from, departmentId });
  const end = await headcount({ asOf: to, departmentId });
  const { exits } = await db.one(
    `select count(*)::int as exits from employees where exit_date between $1 and $2 and ($3::uuid is null or department_id = $3)`,
    [from, to, departmentId]);
  const avg = (start.total + end.total) / 2;
  return { exits, averageHeadcount: avg, attritionPct: avg > 0 ? Math.round((exits / avg) * 1000) / 10 : 0 };
}

export async function payrollCost({ departmentId = null, months = 6 } = {}) {
  return db.query(
    `select to_char(r.period_month, 'YYYY-MM') as month, r.status, p.employee_snapshot->>'department' as department,
            sum(p.prorated_gross)::float as gross, sum(p.net_pay)::float as net, count(*)::int as employees
     from payslips p join payroll_runs r on r.id = p.payroll_run_id
     where r.period_month >= (date_trunc('month', $3::date) - make_interval(months => $2))::date
       and ($1::uuid is null or p.employee_snapshot->>'departmentId' = $1::text)
     group by r.period_month, r.status, department order by r.period_month, department`, [departmentId, months, todayLocal()]);
}

export async function averageSalary({ departmentId = null } = {}) {
  const base = `from employees e join lateral (select gross from salary_structures s where s.employee_id = e.id and s.effective_from <= $2::date
                  order by effective_from desc limit 1) s on true
                join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id
                where e.status in ('active','probation') and exists (select 1 from users u where u.id = e.user_id and u.is_active) and ($1::uuid is null or e.department_id = $1)`;
  const params = [departmentId, todayLocal()];
  const [overall] = await db.query(`select round(avg(s.gross), 2)::float as avg_gross, count(*)::int as n ${base}`, params);
  const byDepartment = await db.query(`select d.name as department, round(avg(s.gross), 2)::float as avg_gross ${base} group by d.name order by d.name`, params);
  const byDesignation = await db.query(`select coalesce(g.title, 'Unassigned') as designation, round(avg(s.gross), 2)::float as avg_gross ${base} group by g.title order by 1`, params);
  return { avgGross: overall.avgGross, byDepartment, byDesignation };
}

export async function genderAndTenure({ asOf = todayLocal(), departmentId = null } = {}) {
  const where = `where join_date <= $1 and (exit_date is null or exit_date >= $1) and exists (select 1 from users u where u.id = employees.user_id and u.is_active) and ($2::uuid is null or department_id = $2)`;
  const gender = await db.query(`select coalesce(gender, 'unspecified') as gender, count(*)::int as count from employees ${where} group by 1 order by 1`, [asOf, departmentId]);
  const tenure = await db.query(
    `select band, count(*)::int as count from (
       select case when age($1::date, join_date) < interval '1 year' then '<1y'
                   when age($1::date, join_date) < interval '3 years' then '1-3y'
                   when age($1::date, join_date) < interval '5 years' then '3-5y' else '5y+' end as band
       from employees ${where}) t group by band order by band`, [asOf, departmentId]);
  return { gender, tenure };
}

// Bonus: absence anomaly flags (explainable rules).
export async function anomalyFlags({ from, to, departmentId = null }) {
  const rows = await db.query(
    `select s.employee_id, e.full_name, s.work_date, s.status, s.is_late, extract(isodow from s.work_date)::int as dow
     from fn_daily_status($1::date, $2::date, $3::uuid, null) s join employees e on e.id = s.employee_id
     where s.is_working_day and s.status not in ('upcoming','not_checked_in') order by s.employee_id, s.work_date`, [from, to, departmentId]);
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, { name: r.fullName, days: [] });
    byEmp.get(r.employeeId).days.push(r);
  }
  const flags = [];
  for (const [employeeId, { name, days }] of byEmp) {
    let run = 0; let maxRun = 0;
    for (const d of days) { run = d.status === 'absent' ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
    if (maxRun >= 2) flags.push({ employeeId, employee: name, flag: 'Consecutive absences', evidence: `${maxRun} working days in a row` });
    const monFri = days.filter((d) => d.status === 'absent' && [1, 5].includes(d.dow)).length;
    if (monFri >= 2) flags.push({ employeeId, employee: name, flag: 'Long-weekend pattern', evidence: `${monFri} absences on Mondays/Fridays` });
    const lates = days.slice(-10).filter((d) => d.isLate).length;
    if (lates >= 3) flags.push({ employeeId, employee: name, flag: 'Frequent late arrivals', evidence: `${lates} lates in the last 10 working days` });
    const missing = days.filter((d) => d.status === 'missing_checkout').length;
    if (missing >= 2) flags.push({ employeeId, employee: name, flag: 'Missing check-outs', evidence: `${missing} days without check-out` });
  }
  return flags;
}

// Bonus: heuristic attrition risk score 0-100 (not a prediction).
export async function attritionRisk({ departmentId = null } = {}) {
  const to = todayLocal();
  const from = addDays(to, -90);
  const rows = await db.query(
    `select e.id as employee_id, e.full_name, e.join_date,
            count(*) filter (where s.status = 'absent')::int as absent,
            count(*) filter (where s.status = 'late')::int as late,
            count(*) filter (where s.status in ('present','late'))::int as attended,
            (count(*) - count(*) filter (where s.status = 'on_leave'))::int as expected,
            (select coalesce(sum(l.days),0) from leave_requests l join leave_types t on t.id = l.leave_type_id
              where l.employee_id = e.id and l.status = 'approved' and not t.is_paid and l.start_date >= $1)::float as unpaid_days
     from employees e left join fn_daily_status($1::date, $2::date, $3::uuid, null) s
       on s.employee_id = e.id and s.is_working_day and s.status not in ('upcoming','not_checked_in')
     where e.status in ('active','probation') and exists (select 1 from users u where u.id = e.user_id and u.is_active) and ($3::uuid is null or e.department_id = $3)
     group by e.id`, [from, to, departmentId]);
  return rows.map((r) => {
    const absPct = r.expected ? (r.absent / r.expected) * 100 : 0;
    const latePct = r.attended ? (r.late / r.attended) * 100 : 0;
    const tenureYears = (new Date(to) - new Date(r.joinDate)) / (365.25 * 86400000);
    const factors = [];
    let score = 30 * Math.min(absPct / 20, 1) + 25 * Math.min(latePct / 30, 1);
    if (absPct > 5) factors.push(`absenteeism ${absPct.toFixed(0)}%`);
    if (latePct > 10) factors.push(`late ${latePct.toFixed(0)}%`);
    if (tenureYears < 1) { score += 15; factors.push('tenure under 1 year'); }
    if (r.unpaidDays >= 3) { score += 15; factors.push(`${r.unpaidDays} unpaid leave days`); }
    score = Math.round(score);
    return { employeeId: r.employeeId, employee: r.fullName, score, level: score > 60 ? 'High' : score >= 35 ? 'Medium' : 'Low', factors };
  }).sort((a, b) => b.score - a.score);
}

// ---- Dashboard payloads ----
export async function hrDashboard(filters) {
  const { from, to } = normalizeRange(filters);
  const departmentId = filters.departmentId || null;
  const today = todayLocal();
  const [hc, todaySummary, summary, trend, absenteeism, leave, late, pending, flags, utilization] = await Promise.all([
    headcount({ asOf: to, departmentId }),
    db.query(`select status, is_late from fn_daily_status($1::date, $1::date, $2::uuid, null)`, [today, departmentId]),
    attendanceSummary({ from, to, departmentId }),
    attendanceTrend({ from, to, departmentId }),
    absenteeismByDepartment({ from, to, departmentId }),
    leaveByType({ from, to, departmentId }),
    lateComers({ from, to, departmentId, limit: 5 }),
    pendingApprovals(),
    anomalyFlags({ from, to, departmentId }),
    leaveUtilization({ year: Number(to.slice(0, 4)), departmentId }),
  ]);
  return {
    filters: { from, to, departmentId },
    kpis: {
      headcount: hc.total,
      presentToday: todaySummary.filter((r) => ['present', 'late', 'half_day'].includes(r.status)).length,
      onLeaveToday: todaySummary.filter((r) => r.status === 'on_leave').length,
      lateToday: todaySummary.filter((r) => r.isLate).length,
      pendingApprovals: pending.leave + pending.corrections,
      pendingLeave: pending.leave,
      pendingCorrections: pending.corrections,
      attendanceRate: summary.attendanceRate,
      latePct: summary.latePct,
    },
    attendanceSummary: summary,
    attendanceTrend: trend,
    absenteeismByDepartment: absenteeism,
    leaveByType: leave,
    topLateComers: late,
    anomalyFlags: flags,
    leaveUtilization: utilization,
  };
}

export async function adminDashboard(filters) {
  const { from, to } = normalizeRange(filters);
  const departmentId = filters.departmentId || null;
  const yearStart = `${to.slice(0, 4)}-01-01`;
  const [hc, attr, cost, salary, byDept, gt, risk, audit] = await Promise.all([
    headcount({ asOf: to, departmentId }),
    attrition({ from: yearStart, to, departmentId }),
    payrollCost({ departmentId }),
    averageSalary({ departmentId }),
    headcountByDepartment(to),
    genderAndTenure({ asOf: to, departmentId }),
    attritionRisk({ departmentId }),
    db.query('select id, action, entity_type, actor_name, actor_role, created_at from audit_logs order by created_at desc limit 10'),
  ]);
  const months = [...new Set(cost.map((c) => c.month))];
  const latestMonth = months[months.length - 1];
  const latest = cost.filter((c) => c.month === latestMonth);
  return {
    filters: { from, to, departmentId },
    kpis: {
      headcount: hc.total,
      attritionYtdPct: attr.attritionPct,
      exitsYtd: attr.exits,
      payrollMonth: latestMonth ?? null,
      payrollGross: latest.reduce((s, c) => s + c.gross, 0),
      payrollNet: latest.reduce((s, c) => s + c.net, 0),
      avgSalary: salary.avgGross,
    },
    headcountByDepartment: byDept,
    payrollCostByDepartment: cost,
    averageSalary: salary,
    gender: gt.gender,
    tenure: gt.tenure,
    attritionRisk: risk.slice(0, 5),
    auditFeed: audit,
  };
}

export async function myDashboard(actor) {
  const today = todayLocal();
  const monthFrom = `${today.slice(0, 7)}-01`;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const weekFrom = addDays(today, 1 - dow);
  const [week, month, lastPayslip] = await Promise.all([
    db.one('select coalesce(sum(worked_minutes), 0)::int as minutes from attendance where employee_id = $1 and work_date between $2 and $3',
      [actor.employeeId, weekFrom, today]),
    attendanceSummary({ from: monthFrom, to: today, employeeId: actor.employeeId }),
    db.one(`select p.id, to_char(r.period_month, 'YYYY-MM') as month, p.net_pay, p.gross from payslips p join payroll_runs r on r.id = p.payroll_run_id
            where p.employee_id = $1 and r.status = 'finalized' order by r.period_month desc limit 1`, [actor.employeeId]),
  ]);
  return {
    hoursThisWeek: Math.round((week.minutes / 60) * 10) / 10,
    hoursTarget: 40,
    lateCountThisMonth: month.lateArrivals,
    attendanceThisMonth: month,
    lastPayslip,
  };
}
