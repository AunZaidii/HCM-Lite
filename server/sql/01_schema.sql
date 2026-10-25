-- HCM Lite schema. Idempotent: safe to run on every deploy.
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;

create table if not exists company_settings (
  id smallint primary key default 1 check (id = 1),
  company_name text not null,
  timezone text not null default 'Asia/Karachi',
  office_start time not null default '09:00',
  office_end time not null default '18:00',
  grace_minutes int not null default 15 check (grace_minutes between 0 and 120),
  half_day_hours numeric(4,2) not null default 5 check (half_day_hours > 0),
  weekend_days int[] not null default '{6,7}',
  office_lat numeric(9,6) check (office_lat between -90 and 90),
  office_lng numeric(9,6) check (office_lng between -180 and 180),
  office_radius_m int not null default 150 check (office_radius_m between 10 and 5000),
  late_penalty_enabled boolean not null default false,
  camera_checkin_enabled boolean not null default false,
  face_match_required boolean not null default false,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table company_settings add column if not exists face_match_required boolean not null default false;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  password_hash text not null,
  role text not null check (role in ('admin','hr','employee')),
  full_name text not null,
  is_active boolean not null default true,
  must_change_password boolean not null default false,
  last_login_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  name citext unique not null,
  code citext unique not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists designations (
  id uuid primary key default gen_random_uuid(),
  title citext unique not null,
  department_id uuid references departments(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references users(id) on delete restrict,
  employee_code citext unique not null,
  full_name text not null,
  email citext unique not null,
  phone text,
  address text,
  gender text check (gender in ('male','female','other')),
  date_of_birth date,
  department_id uuid not null references departments(id),
  designation_id uuid references designations(id) on delete set null,
  employment_type text not null default 'full_time' check (employment_type in ('full_time','part_time','contract','intern')),
  status text not null default 'probation' check (status in ('probation','active','resigned','terminated')),
  join_date date not null,
  exit_date date check (exit_date is null or exit_date >= join_date),
  exit_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists employees_department_idx on employees(department_id);
create index if not exists employees_status_idx on employees(status);

create table if not exists salary_structures (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  basic numeric(12,2) not null check (basic > 0),
  hra numeric(12,2) generated always as (round(basic * 0.40, 2)) stored,
  medical numeric(12,2) generated always as (round(basic * 0.10, 2)) stored,
  gross numeric(12,2) generated always as (round(basic * 1.5, 2)) stored,
  effective_from date not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table if not exists leave_types (
  id uuid primary key default gen_random_uuid(),
  name citext unique not null,
  code citext unique not null,
  yearly_quota int check (yearly_quota is null or yearly_quota >= 0),
  is_paid boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists holidays (
  id uuid primary key default gen_random_uuid(),
  date date unique not null,
  name text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  work_date date not null,
  check_in_at timestamptz not null,
  check_out_at timestamptz check (check_out_at is null or check_out_at > check_in_at),
  status text not null check (status in ('present','late','half_day')),
  is_late boolean not null default false,
  is_off_day boolean not null default false,
  worked_minutes int,
  source text not null default 'web' check (source in ('web','camera','correction')),
  rule_office_start time not null,
  rule_grace_minutes int not null,
  rule_half_day_hours numeric(4,2) not null,
  check_in_lat numeric(9,6),
  check_in_lng numeric(9,6),
  geo_accuracy_m numeric(9,2),
  distance_m numeric(9,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index if not exists attendance_date_idx on attendance(work_date);

create table if not exists checkin_attempts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  reason text not null,
  lat numeric(9,6), lng numeric(9,6), accuracy_m numeric(9,2), distance_m numeric(9,2)
);

-- Bonus face match: only a 128-number descriptor is stored, never a photo.
create table if not exists face_profiles (
  employee_id uuid primary key references employees(id) on delete cascade,
  descriptor float8[] not null check (array_length(descriptor, 1) = 128),
  enrolled_at timestamptz not null default now()
);

alter table attendance add column if not exists face_verified boolean;
alter table attendance add column if not exists liveness_passed boolean;

create table if not exists attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  work_date date not null,
  requested_check_in timestamptz,
  requested_check_out timestamptz,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewer_id uuid references users(id),
  review_comment text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (requested_check_in is not null or requested_check_out is not null)
);
create unique index if not exists corrections_one_pending on attendance_corrections(employee_id, work_date) where status = 'pending';

create table if not exists leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  leave_type_id uuid not null references leave_types(id),
  start_date date not null,
  end_date date not null,
  days numeric(5,1) not null check (days > 0),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  source text not null default 'form' check (source in ('form','smart')),
  reviewer_id uuid references users(id),
  review_comment text,
  reviewed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_emp_status_idx on leave_requests(employee_id, status);
do $$ begin
  alter table leave_requests add constraint leave_no_overlap exclude using gist
    (employee_id with =, daterange(start_date, end_date, '[]') with &&) where (status in ('pending','approved'));
exception when duplicate_object or duplicate_table then null; end $$;

create table if not exists payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_month date unique not null,
  status text not null default 'draft' check (status in ('draft','finalized')),
  working_days int not null,
  total_gross numeric(14,2) not null default 0,
  total_deductions numeric(14,2) not null default 0,
  total_tax numeric(14,2) not null default 0,
  total_net numeric(14,2) not null default 0,
  employee_count int not null default 0,
  warnings jsonb not null default '[]',
  created_by uuid references users(id),
  finalized_by uuid references users(id),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references payroll_runs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  employee_snapshot jsonb not null,
  basic numeric(12,2) not null, hra numeric(12,2) not null, medical numeric(12,2) not null, gross numeric(12,2) not null,
  working_days int not null, employed_working_days int not null,
  proration_factor numeric(6,4) not null,
  prorated_gross numeric(12,2) not null,
  absent_days numeric(5,1) not null default 0,
  unpaid_leave_days numeric(5,1) not null default 0,
  half_days numeric(5,1) not null default 0,
  late_count int not null default 0,
  late_penalty_days numeric(5,1) not null default 0,
  deduction_days numeric(5,1) not null default 0,
  per_day_rate numeric(12,2) not null,
  deduction_amount numeric(12,2) not null,
  tax numeric(12,2) not null,
  net_pay numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);
create index if not exists payslips_employee_idx on payslips(employee_id);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null default 'all' check (audience in ('all','hr','employee')),
  pinned boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, is_read, created_at desc);

create table if not exists audit_logs (
  id bigserial primary key,
  actor_user_id uuid references users(id),
  actor_role text,
  actor_name text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on audit_logs(created_at desc);

create table if not exists ai_logs (
  id bigserial primary key,
  user_id uuid references users(id),
  role text,
  feature text not null,
  input text,
  tools_called jsonb,
  output text,
  status text not null,
  model text,
  latency_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_logs_user_idx on ai_logs(user_id, created_at);

-- Audit log is append-only.
create or replace function fn_audit_append_only() returns trigger language plpgsql as $$
begin raise exception 'audit_logs is append-only'; end $$;
drop trigger if exists trg_audit_append_only on audit_logs;
create trigger trg_audit_append_only before update or delete on audit_logs
  for each row execute function fn_audit_append_only();

-- Finalized payroll is locked.
create or replace function fn_payroll_run_lock() returns trigger language plpgsql as $$
begin
  if old.status = 'finalized' then raise exception 'payroll run is finalized and locked'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_payroll_run_lock on payroll_runs;
create trigger trg_payroll_run_lock before update or delete on payroll_runs
  for each row execute function fn_payroll_run_lock();

create or replace function fn_payslip_lock() returns trigger language plpgsql as $$
begin
  if exists (select 1 from payroll_runs r where r.id = coalesce(old.payroll_run_id, new.payroll_run_id) and r.status = 'finalized') then
    raise exception 'payroll run is finalized and locked';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists trg_payslip_lock on payslips;
create trigger trg_payslip_lock before insert or update or delete on payslips
  for each row execute function fn_payslip_lock();

-- One status per employee per day. Shared by board, calendar, dashboards, payroll and AI.
-- status: present | late | half_day | missing_checkout | absent | on_leave | holiday | weekend | not_checked_in | upcoming
create or replace function fn_daily_status(p_from date, p_to date, p_department uuid default null, p_employee uuid default null)
returns table (
  employee_id uuid, department_id uuid, work_date date, status text,
  is_late boolean, worked_minutes int, is_working_day boolean, leave_type_id uuid, leave_is_paid boolean
) language sql stable as $$
  -- hcm.now (an ISO timestamp) is only ever set by the test suite's frozen clock; production uses now().
  with clk as (
    select coalesce(nullif(current_setting('hcm.now', true), '')::timestamptz, now()) at time zone 'Asia/Karachi' as ts
  ),
  cfg as (
    select weekend_days, office_end, clk.ts::date as today, clk.ts::time as now_t
    from company_settings cross join clk where id = 1
  ),
  days as (select g::date as d from generate_series(p_from, p_to, interval '1 day') g),
  grid as (
    select e.id as employee_id, e.department_id, days.d
    from employees e join days on days.d >= e.join_date and (e.exit_date is null or days.d <= e.exit_date)
    where (p_department is null or e.department_id = p_department)
      and (p_employee is null or e.id = p_employee)
  )
  select g.employee_id, g.department_id, g.d,
    case
      when g.d > cfg.today then 'upcoming'
      when a.id is null and h.id is not null then 'holiday'
      when a.id is null and extract(isodow from g.d)::int = any(cfg.weekend_days) then 'weekend'
      when lr.id is not null then 'on_leave'
      when a.id is not null and a.check_out_at is null and g.d < cfg.today then 'missing_checkout'
      when a.id is not null then a.status
      when g.d = cfg.today and cfg.now_t < cfg.office_end then 'not_checked_in'
      else 'absent'
    end,
    coalesce(a.is_late, false),
    a.worked_minutes,
    (h.id is null and not (extract(isodow from g.d)::int = any(cfg.weekend_days))),
    lr.leave_type_id,
    lt.is_paid
  from grid g
  cross join cfg
  left join attendance a on a.employee_id = g.employee_id and a.work_date = g.d
  left join holidays h on h.date = g.d
  left join leave_requests lr on lr.employee_id = g.employee_id and lr.status = 'approved'
       and g.d between lr.start_date and lr.end_date
  left join leave_types lt on lt.id = lr.leave_type_id
$$;

-- Supabase: the browser never talks to the DB. Lock out the public API roles.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = current_schema() loop
    execute format('alter table %I.%I enable row level security', current_schema(), t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on all tables in schema %I from anon, authenticated', current_schema());
  end if;
end $$;
