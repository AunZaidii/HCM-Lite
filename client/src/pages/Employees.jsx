import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileUp, Pencil, Plus, Search, Upload } from 'lucide-react';
import { api, download, errDetails, errMsg, get, saveText } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, Empty, Field, Kpi, Modal, PageHeader, QueryState, Select, Table, TempPasswordModal,
  cx, fmtDate, fmtDateTime, monthName, pkr, pkr2, todayStr,
} from '../ui';

const STATUSES = ['probation', 'active', 'resigned', 'terminated'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));
const TYPES = [
  { value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' },
  { value: 'contract', label: 'Contract' }, { value: 'intern', label: 'Intern' },
];
const GENDERS = [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }];

const fieldErrors = (err) => Object.fromEntries(errDetails(err).filter((d) => d.field).map((d) => [d.field, d.reason]));
const useDepartments = () => useQuery({ queryKey: ['departments', 'active'], queryFn: () => get('/departments', { active: true }) });
const useDesignations = () => useQuery({ queryKey: ['designations'], queryFn: () => get('/designations') });

// ---------------- Directory ----------------
export function Employees() {
  const { user } = useAuth();
  const isHr = user.role === 'hr';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [f, setF] = useState({ q: '', departmentId: '', status: '', page: 1 });
  useEffect(() => {
    const t = setTimeout(() => setF((p) => (p.q === search ? p : { ...p, q: search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);
  const params = Object.fromEntries(Object.entries({ ...f, pageSize: 20 }).filter(([, v]) => v !== ''));
  const q = useQuery({ queryKey: ['employees', params], queryFn: () => get('/employees', params), placeholderData: (p) => p });
  const depts = useDepartments();
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  const exportCsv = () => download('/employees/export.csv', 'employees.csv', { q: f.q || undefined, departmentId: f.departmentId || undefined, status: f.status || undefined })
    .catch((e) => toast.error(errMsg(e)));

  return (
    <>
      <PageHeader title="Employees" subtitle={q.data ? `${q.data.total} employee(s)` : 'Directory'}
        actions={isHr && (
          <>
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
            <Button variant="secondary" onClick={() => navigate('/employees/import')}><FileUp className="h-4 w-4" /> Import CSV</Button>
            <Button onClick={() => navigate('/employees/new')}><Plus className="h-4 w-4" /> Add employee</Button>
          </>
        )} />
      <Card>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" placeholder="Search name, code or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select placeholder="All departments" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value, page: 1 })}
            options={(depts.data || []).map((d) => ({ value: d.id, label: d.name }))} />
          <Select placeholder="All statuses" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={STATUSES} />
        </div>
        <QueryState q={q} isEmpty={(d) => !d.items.length}
          empty={<Empty title={f.q || f.departmentId || f.status ? 'No employees match these filters' : 'No employees yet'}>
            {isHr && !f.q && <span>Add your first employee or import a CSV.</span>}
          </Empty>}>
          {(d) => (
            <>
              <Table>
                <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>Type</th><th>Joined</th><th>Status</th></tr></thead>
                <tbody>
                  {d.items.map((e) => (
                    <tr key={e.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => navigate(`/employees/${e.id}`)}>
                      <td className="font-mono text-xs">{e.employeeCode}</td>
                      <td>
                        <Link to={`/employees/${e.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-500" onClick={(ev) => ev.stopPropagation()}>{e.fullName}</Link>
                        <div className="text-xs text-slate-500">{e.email}{e.role === 'hr' && ' · HR'}</div>
                      </td>
                      <td>{e.departmentName}</td>
                      <td>{e.designationTitle || '—'}</td>
                      <td className="capitalize">{e.employmentType.replace('_', ' ')}</td>
                      <td>{fmtDate(e.joinDate)}</td>
                      <td><Badge status={e.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
                <span>Page {d.page} of {pages}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={d.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</Button>
                  <Button size="sm" variant="secondary" disabled={d.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</Button>
                </div>
              </div>
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}

// ---------------- Register ----------------
const EMPTY_FORM = {
  employeeCode: '', fullName: '', email: '', phone: '', address: '', gender: '', dateOfBirth: '', departmentId: '',
  designationId: '', employmentType: 'full_time', status: 'probation', joinDate: todayStr(), basicSalary: '',
};

const clean = (form) => Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]));

export function EmployeeForm({ form, setForm, errors, includeSalary = true, includeStatus = true }) {
  const depts = useDepartments();
  const desigs = useDesignations();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const designations = (desigs.data || []).filter((d) => !d.departmentId || !form.departmentId || d.departmentId === form.departmentId);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Employee code *" error={errors.employeeCode}><input className="input" value={form.employeeCode} onChange={set('employeeCode')} required /></Field>
      <Field label="Full name *" error={errors.fullName}><input className="input" value={form.fullName} onChange={set('fullName')} required /></Field>
      <Field label="Email (login) *" error={errors.email}><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
      <Field label="Phone" error={errors.phone}><input className="input" value={form.phone || ''} onChange={set('phone')} /></Field>
      <Field label="Department *" error={errors.departmentId} hint={!depts.isLoading && !depts.data?.length ? 'Admin must create a department first' : undefined}>
        <Select placeholder="Select department" value={form.departmentId} onChange={set('departmentId')} required
          options={(depts.data || []).map((d) => ({ value: d.id, label: d.name }))} />
      </Field>
      <Field label="Designation" error={errors.designationId}>
        <Select placeholder="None" value={form.designationId || ''} onChange={set('designationId')} options={designations.map((d) => ({ value: d.id, label: d.title }))} />
      </Field>
      <Field label="Employment type" error={errors.employmentType}><Select value={form.employmentType} onChange={set('employmentType')} options={TYPES} /></Field>
      {includeStatus && (
        <Field label="Status" error={errors.status}><Select value={form.status} onChange={set('status')} options={STATUSES.slice(0, 2)} /></Field>
      )}
      <Field label="Join date *" error={errors.joinDate}><input className="input" type="date" value={form.joinDate} onChange={set('joinDate')} required /></Field>
      <Field label="Gender" error={errors.gender}><Select placeholder="Not specified" value={form.gender || ''} onChange={set('gender')} options={GENDERS} /></Field>
      <Field label="Date of birth" error={errors.dateOfBirth}><input className="input" type="date" value={form.dateOfBirth || ''} onChange={set('dateOfBirth')} /></Field>
      {includeSalary && (
        <Field label="Basic salary (PKR / month) *" error={errors.basicSalary}
          hint={form.basicSalary > 0 ? `Gross = 1.5 × basic = ${pkr(form.basicSalary * 1.5)} (HRA 40%, medical 10%)` : 'Gross = 1.5 × basic'}>
          <input className="input" type="number" min="1" value={form.basicSalary} onChange={set('basicSalary')} required />
        </Field>
      )}
      <Field label="Address" error={errors.address} className="sm:col-span-2"><input className="input" value={form.address || ''} onChange={set('address')} /></Field>
    </div>
  );
}

export function EmployeeNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [created, setCreated] = useState(null);
  const next = useQuery({ queryKey: ['next-code'], queryFn: () => get('/employees/next-code'), staleTime: 0 });
  useEffect(() => {
    if (next.data?.code) setForm((f) => (f.employeeCode ? f : { ...f, employeeCode: next.data.code }));
  }, [next.data]);

  const save = useMutation({
    mutationFn: () => api.post('/employees', { ...clean(form), basicSalary: Number(form.basicSalary) }).then((r) => r.data),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast.success(`${d.employee.fullName} registered`);
      setCreated({ id: d.employee.id, name: d.employee.fullName, email: d.employee.email, password: d.tempPassword });
    },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errMsg(e)); },
  });

  return (
    <>
      <PageHeader title="Register employee" subtitle="Creates the employee profile, salary structure and a login with a temporary password." />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }}>
          <EmployeeForm form={form} setForm={setForm} errors={errors} />
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate('/employees')}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Register employee</Button>
          </div>
        </form>
      </Card>
      <TempPasswordModal data={created} onClose={() => navigate(`/employees/${created.id}`)} />
    </>
  );
}

// ---------------- CSV import ----------------
export function EmployeeImport() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);

  const send = (dryRun) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/employees/import?dryRun=${dryRun}`, fd).then((r) => r.data);
  };
  const dry = useMutation({ mutationFn: () => send(true), onSuccess: setReport, onError: (e) => { setReport(null); toast.error(errMsg(e)); } });
  const commit = useMutation({
    mutationFn: () => send(false),
    onSuccess: (d) => {
      saveText(d.credentialsCsv, 'credentials.csv');
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast.success(`${d.created} employee(s) imported. Credentials file downloaded — share it securely.`);
      navigate('/employees');
    },
    onError: (e) => {
      const details = errDetails(e);
      if (details.length) setReport((r) => ({ ...(r || {}), errors: details }));
      toast.error(errMsg(e));
    },
  });

  return (
    <>
      <PageHeader title="Import employees" subtitle="Upload a CSV, review the dry-run report, then commit. Nothing is saved unless every row is valid."
        actions={<Button variant="secondary" onClick={() => download('/employees/import/template', 'employees-template.csv').catch((e) => toast.error(errMsg(e)))}>
          <Download className="h-4 w-4" /> Download template</Button>} />
      <Card title="1. Choose a CSV file">
        <p className="mb-3 text-sm text-slate-500">
          Columns: employee_code, full_name, email, phone, gender, department (name or code), designation, employment_type, join_date (YYYY-MM-DD), basic_salary, address. Max 500 rows, 1 MB.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input type="file" accept=".csv,text/csv" className="input sm:max-w-sm" onChange={(e) => { setFile(e.target.files?.[0] || null); setReport(null); }} />
          <Button disabled={!file} loading={dry.isPending} onClick={() => dry.mutate()}><Upload className="h-4 w-4" /> Run dry run</Button>
        </div>
      </Card>
      {report && (
        <Card title="2. Dry-run report" className="mt-4"
          actions={<Button disabled={!!report.errors?.length || !report.validRows} loading={commit.isPending} onClick={() => commit.mutate()}>
            Commit import ({report.validRows ?? 0})</Button>}>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Kpi label="Rows in file" value={report.totalRows} tone="slate" />
            <Kpi label="Valid rows" value={report.validRows} />
            <Kpi label="Errors" value={report.errors?.length ?? 0} tone={report.errors?.length ? 'red' : 'brand'} />
          </div>
          {report.errors?.length ? (
            <Table>
              <thead><tr><th>Row</th><th>Field</th><th>Reason</th></tr></thead>
              <tbody>{report.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td className="font-mono text-xs">{e.field}</td><td className="text-red-700 dark:text-red-400">{e.reason}</td></tr>)}</tbody>
            </Table>
          ) : <Empty title="No errors found">All rows are valid. Commit to create the employees and their logins.</Empty>}
        </Card>
      )}
    </>
  );
}

// ---------------- Employee 360 ----------------
const TABS = ['Profile', 'Attendance', 'Leave', 'Salary', 'Payslips', 'Activity'];

function Info({ label, children }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-medium">{children || '—'}</div>
    </div>
  );
}

function EditEmployee({ profile, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    employeeCode: profile.employeeCode, fullName: profile.fullName, email: profile.email, phone: profile.phone || '', address: profile.address || '',
    gender: profile.gender || '', dateOfBirth: profile.dateOfBirth || '', departmentId: profile.departmentId, designationId: profile.designationId || '',
    employmentType: profile.employmentType, joinDate: profile.joinDate, status: profile.status, exitDate: profile.exitDate || '', exitReason: profile.exitReason || '',
  });
  const [errors, setErrors] = useState({});
  const save = useMutation({
    mutationFn: () => api.put(`/employees/${profile.id}`, clean(form)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employee360', profile.id] }); qc.invalidateQueries({ queryKey: ['employees'] }); toast.success('Employee updated'); onClose(); },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errMsg(e)); },
  });
  const leaving = ['resigned', 'terminated'].includes(form.status);
  return (
    <Modal open wide title={`Edit ${profile.fullName}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => { setErrors({}); save.mutate(); }}>Save changes</Button></>}>
      <EmployeeForm form={form} setForm={setForm} errors={errors} includeSalary={false} includeStatus={false} />
      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800">
        <Field label="Status" error={errors.status}><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={STATUSES} /></Field>
        <Field label={`Exit date${leaving ? ' *' : ''}`} error={errors.exitDate}>
          <input className="input" type="date" value={form.exitDate} onChange={(e) => setForm({ ...form, exitDate: e.target.value })} />
        </Field>
        <Field label="Exit reason" error={errors.exitReason}><input className="input" value={form.exitReason} onChange={(e) => setForm({ ...form, exitReason: e.target.value })} /></Field>
      </div>
      {leaving && <p className="mt-2 text-xs text-amber-700">The login is deactivated once the exit date has passed. Payroll prorates the final month.</p>}
    </Modal>
  );
}

function SalaryTab({ id, data, canEdit }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ basic: '', effectiveFrom: todayStr() });
  const add = useMutation({
    mutationFn: () => api.post(`/employees/${id}/salary`, { basic: Number(form.basic), effectiveFrom: form.effectiveFrom }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employee360', id] }); toast.success('Salary structure saved'); setForm({ basic: '', effectiveFrom: todayStr() }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const current = data.profile.salary;
  return (
    <div className="space-y-4">
      {current ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Basic" value={pkr(current.basic)} tone="slate" />
          <Kpi label="HRA (40%)" value={pkr(current.hra)} tone="slate" />
          <Kpi label="Medical (10%)" value={pkr(current.medical)} tone="slate" />
          <Kpi label="Gross (1.5 × basic)" value={pkr(current.gross)} sub={`Effective ${fmtDate(current.effectiveFrom)}`} />
        </div>
      ) : <Empty title="No salary structure">Payroll skips employees without a salary structure.</Empty>}
      {canEdit && (
        <form className="grid grid-cols-1 items-end gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3 dark:bg-slate-800/50"
          onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="New basic salary (PKR)" hint={form.basic > 0 ? `Gross will be ${pkr(form.basic * 1.5)}` : 'Gross = 1.5 × basic'}>
            <input className="input" type="number" min="1" required value={form.basic} onChange={(e) => setForm({ ...form, basic: e.target.value })} />
          </Field>
          <Field label="Effective from"><input className="input" type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></Field>
          <Button type="submit" loading={add.isPending}>Save salary</Button>
        </form>
      )}
      {data.salaryHistory?.length > 0 && (
        <Table>
          <thead><tr><th>Effective from</th><th>Basic</th><th>HRA</th><th>Medical</th><th>Gross</th></tr></thead>
          <tbody>{data.salaryHistory.map((s) => (
            <tr key={s.id}><td>{fmtDate(s.effectiveFrom)}</td><td>{pkr(s.basic)}</td><td>{pkr(s.hra)}</td><td>{pkr(s.medical)}</td><td className="font-medium">{pkr(s.gross)}</td></tr>
          ))}</tbody>
        </Table>
      )}
    </div>
  );
}

export function Employee360() {
  const { id } = useParams();
  const { user } = useAuth();
  const [tab, setTab] = useState('Profile');
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['employee360', id], queryFn: () => get(`/employees/${id}/360`) });
  const tabs = TABS.filter((t) => (t !== 'Activity' || user.role === 'admin') && (t !== 'Salary' || user.role !== 'employee'));

  return (
    <QueryState q={q} rows={6}>
      {(d) => {
        const p = d.profile;
        const a = d.attendanceThisMonth || {};
        return (
          <>
            <PageHeader title={p.fullName}
              subtitle={`${p.employeeCode} · ${p.designationTitle || 'No designation'} · ${p.departmentName}`}
              actions={<>
                <Badge status={p.status} />
                {!p.isActive && <Badge status="rejected">Login disabled</Badge>}
                {user.role === 'hr' && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>}
              </>} />
            <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
              {tabs.map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-brand-700 text-brand-700 dark:text-brand-500' : 'border-transparent text-slate-500 hover:text-slate-700')}>
                  {t}
                </button>
              ))}
            </div>

            {tab === 'Profile' && (
              <Card>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Info label="Email">{p.email}</Info>
                  <Info label="Phone">{p.phone}</Info>
                  <Info label="Gender"><span className="capitalize">{p.gender}</span></Info>
                  <Info label="Department">{p.departmentName}</Info>
                  <Info label="Designation">{p.designationTitle}</Info>
                  <Info label="Employment type"><span className="capitalize">{p.employmentType?.replace('_', ' ')}</span></Info>
                  <Info label="Join date">{fmtDate(p.joinDate)}</Info>
                  <Info label="Exit date">{p.exitDate && fmtDate(p.exitDate)}</Info>
                  <Info label="Date of birth">{p.dateOfBirth && fmtDate(p.dateOfBirth)}</Info>
                  <Info label="Login role"><span className="uppercase">{p.role}</span></Info>
                  <Info label="Last sign-in">{p.lastLoginAt && fmtDateTime(p.lastLoginAt)}</Info>
                  <Info label="Address">{p.address}</Info>
                  {p.exitReason && <Info label="Exit reason">{p.exitReason}</Info>}
                </div>
              </Card>
            )}

            {tab === 'Attendance' && (
              <Card title="This month" actions={<Link className="text-sm font-medium text-brand-700" to={`/attendance/calendar?employeeId=${id}`}>Open calendar</Link>}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Kpi label="Present" value={a.present} />
                  <Kpi label="Late" value={a.late} tone="amber" />
                  <Kpi label="Half day" value={a.halfDay} tone="amber" />
                  <Kpi label="Absent" value={a.absent} tone="red" />
                  <Kpi label="On leave" value={a.onLeave} tone="blue" />
                  <Kpi label="Missing checkout" value={a.missingCheckout} tone="violet" />
                </div>
                {d.corrections?.length > 0 && (
                  <div className="mt-4">
                    <h3 className="mb-2 text-sm font-semibold">Recent corrections</h3>
                    <Table>
                      <thead><tr><th>Date</th><th>Reason</th><th>Status</th></tr></thead>
                      <tbody>{d.corrections.map((c) => <tr key={c.id}><td>{fmtDate(c.workDate)}</td><td>{c.reason}</td><td><Badge status={c.status} /></td></tr>)}</tbody>
                    </Table>
                  </div>
                )}
              </Card>
            )}

            {tab === 'Leave' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {d.leaveBalances.map((b) => (
                    <Kpi key={b.leaveTypeId} label={b.name} tone="blue"
                      value={b.quota === null ? '∞' : b.remaining}
                      sub={b.quota === null ? `${b.approved} taken` : `of ${b.quota} · ${b.approved} taken · ${b.pending} pending`} />
                  ))}
                </div>
                <Card title="Recent leave">
                  {d.recentLeaves.length ? (
                    <Table>
                      <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr></thead>
                      <tbody>{d.recentLeaves.map((l) => (
                        <tr key={l.id}><td>{l.leaveTypeName}</td><td>{fmtDate(l.startDate)}</td><td>{fmtDate(l.endDate)}</td><td>{l.days}</td><td><Badge status={l.status} /></td></tr>
                      ))}</tbody>
                    </Table>
                  ) : <Empty title="No leave requests yet" />}
                </Card>
              </div>
            )}

            {tab === 'Salary' && <Card title="Salary structure"><SalaryTab id={id} data={d} canEdit={user.role === 'hr' && user.employeeId !== id} /></Card>}

            {tab === 'Payslips' && (
              <Card title="Payslips">
                {d.payslips.length ? (
                  <Table>
                    <thead><tr><th>Month</th><th>Gross</th><th>Net pay</th><th>Run</th><th /></tr></thead>
                    <tbody>{d.payslips.map((s) => (
                      <tr key={s.id}>
                        <td>{monthName(String(s.periodMonth).slice(0, 7))}</td><td>{pkr2(s.gross)}</td><td className="font-medium">{pkr2(s.netPay)}</td>
                        <td><Badge status={s.runStatus} /></td>
                        <td className="text-right"><Button size="sm" variant="secondary"
                          onClick={() => download(`/payslips/${s.id}/pdf`, 'payslip.pdf').catch((e) => toast.error(errMsg(e)))}>PDF</Button></td>
                      </tr>
                    ))}</tbody>
                  </Table>
                ) : <Empty title="No payslips yet">Payslips appear after HR runs payroll.</Empty>}
              </Card>
            )}

            {tab === 'Activity' && (
              <Card title="Audit timeline">
                {d.timeline.length ? (
                  <ul className="space-y-2">
                    {d.timeline.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span><span className="font-mono text-xs">{t.action}</span> by {t.actorName || 'system'}</span>
                        <span className="text-xs text-slate-500">{fmtDateTime(t.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <Empty title="No activity recorded" />}
              </Card>
            )}

            {editing && <EditEmployee profile={p} onClose={() => setEditing(false)} />}
          </>
        );
      }}
    </QueryState>
  );
}

// ---------------- My profile ----------------
export function Profile() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-profile'], queryFn: () => get('/employees/me') });
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (q.data && !form) setForm({ phone: q.data.phone || '', address: q.data.address || '' });
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: () => api.patch('/employees/me', { phone: form.phone || null, address: form.address || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me-profile'] }); toast.success('Profile updated'); },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <>
      <PageHeader title="My profile" subtitle="You can update your phone and address. Ask HR to change anything else."
        actions={<Link to="/change-password"><Button variant="secondary">Change password</Button></Link>} />
      <QueryState q={q} rows={5}>
        {(p) => (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Job details" className="lg:col-span-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Info label="Name">{p.fullName}</Info>
                <Info label="Employee code">{p.employeeCode}</Info>
                <Info label="Email">{p.email}</Info>
                <Info label="Department">{p.departmentName}</Info>
                <Info label="Designation">{p.designationTitle}</Info>
                <Info label="Employment type"><span className="capitalize">{p.employmentType?.replace('_', ' ')}</span></Info>
                <Info label="Join date">{fmtDate(p.joinDate)}</Info>
                <Info label="Status"><Badge status={p.status} /></Info>
              </div>
            </Card>
            <Card title="Contact details">
              {form && (
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                  <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                  <Field label="Address"><textarea className="input" rows={3} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
                  <Button type="submit" loading={save.isPending} className="w-full">Save</Button>
                </form>
              )}
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}
