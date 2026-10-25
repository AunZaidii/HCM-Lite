import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, LocateFixed, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api, errDetails, errMsg, get } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, Empty, Field, Modal, PageHeader, QueryState, Select, Table, TempPasswordModal, cx, fmtDate, fmtDateTime, todayStr,
} from '../ui';

const fieldErrors = (err) => Object.fromEntries(errDetails(err).filter((d) => d.field).map((d) => [d.field, d.reason]));
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

function Toggle({ label, checked, onChange, disabled, hint }) {
  return (
    <label className={cx('flex items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800', disabled && 'opacity-70')}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal-700" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------- Company settings ----------------
export function Settings() {
  const { user, reload } = useAuth();
  const isAdmin = user.role === 'admin';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    const s = q.data;
    setForm({
      companyName: s.companyName, officeStart: hhmm(s.officeStart), officeEnd: hhmm(s.officeEnd), graceMinutes: s.graceMinutes,
      halfDayHours: s.halfDayHours, weekendDays: s.weekendDays || [], officeLat: s.officeLat ?? '', officeLng: s.officeLng ?? '',
      officeRadiusM: s.officeRadiusM, latePenaltyEnabled: s.latePenaltyEnabled, cameraCheckinEnabled: s.cameraCheckinEnabled,
      faceMatchRequired: s.faceMatchRequired,
    });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.put('/settings', {
      ...form,
      graceMinutes: Number(form.graceMinutes), halfDayHours: Number(form.halfDayHours), officeRadiusM: Number(form.officeRadiusM),
      officeLat: form.officeLat === '' ? null : Number(form.officeLat), officeLng: form.officeLng === '' ? null : Number(form.officeLng),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); reload(); toast.success('Settings saved. New rules apply to new records only.'); },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errMsg(e)); },
  });

  const locate = () => {
    if (!navigator.geolocation) return toast.error('Location is not available in this browser');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setForm((f) => ({ ...f, officeLat: pos.coords.latitude.toFixed(6), officeLng: pos.coords.longitude.toFixed(6) }));
        toast.success(`Location captured (accuracy ${Math.round(pos.coords.accuracy)} m)`);
      },
      (err) => { setLocating(false); toast.error(err.message || 'Could not get location'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const toggleDay = (d) => setForm({ ...form, weekendDays: form.weekendDays.includes(d) ? form.weekendDays.filter((x) => x !== d) : [...form.weekendDays, d].sort() });

  return (
    <>
      <PageHeader title="Company settings" subtitle={isAdmin ? 'Rules apply to new attendance, leave and payroll records only.' : 'Read only — only Admin can change company settings.'} />
      <QueryState q={q} rows={6}>
        {() => form && (
          <form onSubmit={(e) => { e.preventDefault(); setErrors({}); save.mutate(); }} className="space-y-4">
            <fieldset disabled={!isAdmin} className="space-y-4">
              <Card title="Company & office hours">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Company name" error={errors.companyName} className="sm:col-span-2 lg:col-span-3">
                    <input className="input" value={form.companyName} onChange={set('companyName')} required />
                  </Field>
                  <Field label="Office start" error={errors.officeStart}><input className="input" type="time" value={form.officeStart} onChange={set('officeStart')} required /></Field>
                  <Field label="Office end" error={errors.officeEnd}><input className="input" type="time" value={form.officeEnd} onChange={set('officeEnd')} required /></Field>
                  <Field label="Grace time (minutes)" error={errors.graceMinutes} hint="Check-in after start + grace is late">
                    <input className="input" type="number" min="0" max="120" value={form.graceMinutes} onChange={set('graceMinutes')} required />
                  </Field>
                  <Field label="Half day if worked under (hours)" error={errors.halfDayHours}>
                    <input className="input" type="number" step="0.5" min="0.5" max="12" value={form.halfDayHours} onChange={set('halfDayHours')} required />
                  </Field>
                  <div className="sm:col-span-2">
                    <span className="label">Weekend days</span>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAYS.map((d, i) => (
                        <button type="button" key={d} disabled={!isAdmin} onClick={() => toggleDay(i + 1)}
                          className={cx('rounded-lg border px-3 py-1.5 text-sm font-medium',
                            form.weekendDays.includes(i + 1) ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 dark:border-slate-700')}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
              <Card title="Office location (camera check-in)" actions={isAdmin && (
                <Button type="button" size="sm" variant="secondary" loading={locating} onClick={locate}><LocateFixed className="h-4 w-4" /> Use my current location</Button>
              )}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Latitude" error={errors.officeLat}><input className="input" type="number" step="any" value={form.officeLat} onChange={set('officeLat')} /></Field>
                  <Field label="Longitude" error={errors.officeLng}><input className="input" type="number" step="any" value={form.officeLng} onChange={set('officeLng')} /></Field>
                  <Field label="Radius (metres)" error={errors.officeRadiusM}><input className="input" type="number" min="10" max="5000" value={form.officeRadiusM} onChange={set('officeRadiusM')} /></Field>
                </div>
              </Card>
              <Card title="Rules & features">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Toggle label="Camera check-in" hint="Face detection + inside the office radius, GPS accuracy ≤ 100 m"
                    checked={form.cameraCheckinEnabled} disabled={!isAdmin} onChange={(v) => setForm({ ...form, cameraCheckinEnabled: v })} />
                  <Toggle label="Late penalty" hint="Every 3 lates in a month deduct 0.5 day in payroll"
                    checked={form.latePenaltyEnabled} disabled={!isAdmin} onChange={(v) => setForm({ ...form, latePenaltyEnabled: v })} />
                  <Toggle label="Require face match + blink" hint="Camera check-in must match the employee's enrolled face and pass a blink check"
                    checked={form.faceMatchRequired} disabled={!isAdmin} onChange={(v) => setForm({ ...form, faceMatchRequired: v })} />
                </div>
              </Card>
            </fieldset>
            {isAdmin && <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Save settings</Button></div>}
          </form>
        )}
      </QueryState>
    </>
  );
}

// ---------------- Organization: departments, designations, leave types, holidays ----------------
const ORG_TABS = {
  departments: {
    label: 'Departments', path: '/departments', entity: 'department',
    empty: { name: '', code: '' },
    columns: [['Name', (r) => r.name], ['Code', (r) => <span className="font-mono text-xs">{r.code}</span>], ['Status', (r) => <Badge status={r.isActive ? 'active' : 'rejected'}>{r.isActive ? 'Active' : 'Inactive'}</Badge>]],
  },
  designations: {
    label: 'Designations', path: '/designations', entity: 'designation',
    empty: { title: '', departmentId: '' },
    columns: [['Title', (r) => r.title], ['Department', (r, ctx) => ctx.deptName(r.departmentId) || 'Any']],
  },
  leaveTypes: {
    label: 'Leave types', path: '/leave-types', entity: 'leave type',
    empty: { name: '', code: '', yearlyQuota: '', isPaid: true },
    columns: [['Name', (r) => r.name], ['Code', (r) => <span className="font-mono text-xs">{r.code}</span>],
      ['Yearly quota', (r) => (r.yearlyQuota === null ? 'Unlimited' : `${r.yearlyQuota} days`)], ['Paid', (r) => (r.isPaid ? 'Paid' : 'Unpaid')]],
  },
  holidays: {
    label: 'Public holidays', path: '/holidays', entity: 'holiday',
    empty: { date: todayStr(), name: '' },
    columns: [['Date', (r) => fmtDate(r.date)], ['Name', (r) => r.name]],
  },
};

function OrgForm({ tab, form, setForm, errors, departments }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  if (tab === 'departments') return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} required /></Field>
      <Field label="Code" error={errors.code} hint="Used in CSV import, e.g. ENG"><input className="input" value={form.code} onChange={set('code')} required /></Field>
    </div>
  );
  if (tab === 'designations') return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Title" error={errors.title}><input className="input" value={form.title} onChange={set('title')} required /></Field>
      <Field label="Department (optional)" error={errors.departmentId}>
        <Select placeholder="Any department" value={form.departmentId || ''} onChange={set('departmentId')} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
      </Field>
    </div>
  );
  if (tab === 'leaveTypes') return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} required /></Field>
      <Field label="Code" error={errors.code}><input className="input" value={form.code} onChange={set('code')} required /></Field>
      <Field label="Yearly quota (days)" error={errors.yearlyQuota} hint="Leave blank for unlimited">
        <input className="input" type="number" min="0" max="365" value={form.yearlyQuota ?? ''} onChange={set('yearlyQuota')} />
      </Field>
      <Field label="Pay">
        <Select value={form.isPaid ? 'true' : 'false'} onChange={(e) => setForm({ ...form, isPaid: e.target.value === 'true' })}
          options={[{ value: 'true', label: 'Paid' }, { value: 'false', label: 'Unpaid (deducted in payroll)' }]} />
      </Field>
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Date" error={errors.date}><input className="input" type="date" value={form.date} onChange={set('date')} required /></Field>
      <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} required /></Field>
    </div>
  );
}

function toPayload(tab, form) {
  if (tab === 'departments') return { name: form.name, code: form.code };
  if (tab === 'designations') return { title: form.title, departmentId: form.departmentId || null };
  if (tab === 'leaveTypes') return { name: form.name, code: form.code, yearlyQuota: form.yearlyQuota === '' || form.yearlyQuota === null ? null : Number(form.yearlyQuota), isPaid: form.isPaid };
  return { date: form.date, name: form.name };
}

export function Org() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const qc = useQueryClient();
  const [tab, setTab] = useState('departments');
  const [editing, setEditing] = useState(null); // { id?, form }
  const [deleting, setDeleting] = useState(null);
  const [errors, setErrors] = useState({});
  const cfg = ORG_TABS[tab];
  const q = useQuery({ queryKey: ['org', tab], queryFn: () => get(cfg.path) });
  const depts = useQuery({ queryKey: ['org', 'departments'], queryFn: () => get('/departments') });
  const ctx = { deptName: (id) => depts.data?.find((d) => d.id === id)?.name };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['org'] });
    qc.invalidateQueries({ queryKey: ['departments'] });
    qc.invalidateQueries({ queryKey: ['designations'] });
    qc.invalidateQueries({ queryKey: ['leave-types'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = toPayload(tab, editing.form);
      return editing.id ? api.put(`${cfg.path}/${editing.id}`, body) : api.post(cfg.path, body);
    },
    onSuccess: () => { invalidate(); toast.success(`${cfg.entity[0].toUpperCase()}${cfg.entity.slice(1)} saved`); setEditing(null); },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errMsg(e)); },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`${cfg.path}/${deleting.id}`),
    onSuccess: () => { invalidate(); toast.success('Deleted'); setDeleting(null); },
    onError: (e) => { toast.error(errMsg(e)); setDeleting(null); },
  });
  const standard = useMutation({
    mutationFn: () => api.post('/leave-types/standard').then((r) => r.data),
    onSuccess: (rows) => { invalidate(); toast.success(rows.length ? `Added ${rows.length} leave type(s)` : 'Standard leave types already exist'); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const openNew = () => { setErrors({}); setEditing({ form: { ...cfg.empty } }); };
  const openEdit = (r) => {
    setErrors({});
    const form = Object.fromEntries(Object.keys(cfg.empty).map((k) => [k, r[k] ?? (k === 'yearlyQuota' ? '' : r[k])]));
    setEditing({ id: r.id, form });
  };

  return (
    <>
      <PageHeader title="Organization" subtitle={isAdmin ? 'Departments, designations, leave types and public holidays.' : 'Read only — managed by Admin.'}
        actions={isAdmin && (
          <>
            {tab === 'leaveTypes' && (
              <Button variant="secondary" loading={standard.isPending} onClick={() => standard.mutate()}>Add standard types (Annual 14, Sick 8, Casual 10, Unpaid)</Button>
            )}
            <Button onClick={openNew}><Plus className="h-4 w-4" /> Add {cfg.entity}</Button>
          </>
        )} />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {Object.entries(ORG_TABS).map(([key, t]) => (
          <button key={key} onClick={() => setTab(key)}
            className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === key ? 'border-brand-700 text-brand-700 dark:text-brand-500' : 'border-transparent text-slate-500 hover:text-slate-700')}>
            {t.label}
          </button>
        ))}
      </div>
      <Card>
        <QueryState q={q} isEmpty={(d) => !d.length}
          empty={<Empty title={`No ${cfg.label.toLowerCase()} yet`}>{isAdmin ? `Add the first ${cfg.entity}.` : 'Admin has not added any yet.'}</Empty>}>
          {(rows) => (
            <Table>
              <thead><tr>{cfg.columns.map(([h]) => <th key={h}>{h}</th>)}{isAdmin && <th className="text-right">Actions</th>}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {cfg.columns.map(([h, render]) => <td key={h}>{render(r, ctx)}</td>)}
                    {isAdmin && (
                      <td className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} aria-label="Delete"><Trash2 className="h-4 w-4 text-red-600" /></Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={!!editing} title={`${editing?.id ? 'Edit' : 'Add'} ${cfg.entity}`} onClose={() => setEditing(null)}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {editing && (
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <OrgForm tab={tab} form={editing.form} setForm={(form) => setEditing({ ...editing, form })} errors={errors} departments={depts.data || []} />
          </form>
        )}
      </Modal>

      <Modal open={!!deleting} title={`Delete ${cfg.entity}?`} onClose={() => setDeleting(null)}
        footer={<><Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete</Button></>}>
        <p className="text-sm">Delete <b>{deleting?.name || deleting?.title}</b>? Records already using it will block the delete.</p>
      </Modal>
    </>
  );
}

// ---------------- Users & logins ----------------
const EMPTY_HR = { employeeCode: '', fullName: '', email: '', phone: '', gender: '', departmentId: '', designationId: '', joinDate: todayStr(), basicSalary: '' };

export function Users() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [role, setRole] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_HR);
  const [errors, setErrors] = useState({});
  const [secret, setSecret] = useState(null);
  const [confirm, setConfirm] = useState(null); // { user, action }
  const q = useQuery({ queryKey: ['users', role], queryFn: () => get('/users', role ? { role } : undefined) });
  const depts = useQuery({ queryKey: ['departments', 'active'], queryFn: () => get('/departments', { active: true }) });
  const desigs = useQuery({ queryKey: ['designations'], queryFn: () => get('/designations') });

  const create = useMutation({
    mutationFn: () => api.post('/users', {
      role: 'hr', ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])),
      basicSalary: Number(form.basicSalary),
    }).then((r) => r.data),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      setCreating(false);
      setForm(EMPTY_HR);
      setSecret({ name: d.employee.fullName, email: d.employee.email, password: d.tempPassword });
    },
    onError: (e) => { setErrors(fieldErrors(e)); toast.error(errMsg(e)); },
  });

  const act = useMutation({
    mutationFn: ({ u, action }) => api.post(`/users/${u.id}/${action}`).then((r) => ({ data: r.data, u, action })),
    onSuccess: ({ data, u, action }) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setConfirm(null);
      if (action === 'reset-password') setSecret({ name: u.fullName, email: u.email, password: data.tempPassword });
      else toast.success(`${u.fullName} ${action === 'deactivate' ? 'deactivated' : 'reactivated'}`);
    },
    onError: (e) => { toast.error(errMsg(e)); setConfirm(null); },
  });

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const confirmText = {
    deactivate: 'They will be signed out and cannot sign in until reactivated.',
    reactivate: 'They will be able to sign in again.',
    'reset-password': 'A new temporary password will be generated. They must change it at next sign-in.',
  };

  return (
    <>
      <PageHeader title="Users & logins" subtitle="Admin creates HR logins. HR registering an employee creates that employee's login."
        actions={<Button onClick={() => { setErrors({}); setCreating(true); }}><Plus className="h-4 w-4" /> Create HR login</Button>} />
      <Card actions={<Select placeholder="All roles" value={role} onChange={(e) => setRole(e.target.value)}
        options={[{ value: 'admin', label: 'Admin' }, { value: 'hr', label: 'HR' }, { value: 'employee', label: 'Employee' }]} />} title="Logins">
        <QueryState q={q} isEmpty={(d) => !d.length} empty={<Empty title="No users found" />}>
          {(rows) => (
            <Table>
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th className="text-right">Actions</th></tr></thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="font-medium">{u.fullName}</div>
                      <div className="text-xs text-slate-500">{u.email}{u.employeeCode && ` · ${u.employeeCode}`}</div>
                    </td>
                    <td className="uppercase text-xs font-semibold">{u.role}</td>
                    <td>
                      <Badge status={u.isActive ? 'active' : 'rejected'}>{u.isActive ? 'Active' : 'Deactivated'}</Badge>
                      {u.mustChangePassword && <span className="ml-1 text-xs text-amber-700">temp password</span>}
                    </td>
                    <td className="text-xs">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                    <td className="whitespace-nowrap text-right">
                      {u.id !== user.id && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setConfirm({ u, action: 'reset-password' })}><KeyRound className="h-4 w-4" /> Reset</Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirm({ u, action: u.isActive ? 'deactivate' : 'reactivate' })}>
                            <Power className={cx('h-4 w-4', u.isActive ? 'text-red-600' : 'text-emerald-600')} /> {u.isActive ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Card>

      <Modal open={creating} wide title="Create HR login" onClose={() => setCreating(false)}
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button loading={create.isPending} onClick={() => { setErrors({}); create.mutate(); }}>Create login</Button></>}>
        <p className="mb-4 text-sm text-slate-500">HR users are also employees: they check in, apply for leave and receive payslips.</p>
        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Employee code *" error={errors.employeeCode}><input className="input" value={form.employeeCode} onChange={set('employeeCode')} placeholder="HR-001" required /></Field>
          <Field label="Full name *" error={errors.fullName}><input className="input" value={form.fullName} onChange={set('fullName')} required /></Field>
          <Field label="Email *" error={errors.email}><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
          <Field label="Phone" error={errors.phone}><input className="input" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Department *" error={errors.departmentId} hint={!depts.data?.length ? 'Create a department in Organization first' : undefined}>
            <Select placeholder="Select department" value={form.departmentId} onChange={set('departmentId')} options={(depts.data || []).map((d) => ({ value: d.id, label: d.name }))} />
          </Field>
          <Field label="Designation" error={errors.designationId}>
            <Select placeholder="None" value={form.designationId} onChange={set('designationId')} options={(desigs.data || []).map((d) => ({ value: d.id, label: d.title }))} />
          </Field>
          <Field label="Join date *" error={errors.joinDate}><input className="input" type="date" value={form.joinDate} onChange={set('joinDate')} required /></Field>
          <Field label="Gender" error={errors.gender}>
            <Select placeholder="Not specified" value={form.gender} onChange={set('gender')} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
          </Field>
          <Field label="Basic salary (PKR) *" error={errors.basicSalary} hint={form.basicSalary > 0 ? `Gross = ${(form.basicSalary * 1.5).toLocaleString()} (1.5 × basic)` : 'Gross = 1.5 × basic'}>
            <input className="input" type="number" min="1" value={form.basicSalary} onChange={set('basicSalary')} required />
          </Field>
        </form>
      </Modal>

      <Modal open={!!confirm} title={confirm ? `${confirm.action === 'reset-password' ? 'Reset password for' : confirm.action === 'deactivate' ? 'Deactivate' : 'Reactivate'} ${confirm.u.fullName}?` : ''}
        onClose={() => setConfirm(null)}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm?.action === 'deactivate' ? 'danger' : 'primary'} loading={act.isPending} onClick={() => act.mutate(confirm)}>Confirm</Button></>}>
        <p className="text-sm">{confirm && confirmText[confirm.action]}</p>
      </Modal>

      <TempPasswordModal data={secret} onClose={() => setSecret(null)} />
    </>
  );
}
