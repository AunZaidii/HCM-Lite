import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, KeyRound, LogIn } from 'lucide-react';
import { api, errDetails, errMsg } from '../api';
import { useAuth } from '../auth';
import { Button, Field } from '../ui';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

function AuthFrame({ title, subtitle, icon: Icon, children, wide }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-ink to-slate-900 p-4">
      <div className={`card w-full p-6 sm:p-8 ${wide ? 'max-w-xl' : 'max-w-md'}`}>
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-700 text-white"><Icon className="h-5 w-5" /></div>
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldErrors = (err) => Object.fromEntries(errDetails(err).map((d) => [d.field, d.reason]));

// First run: company profile + Admin account (or company only when Admin comes from env).
export function Setup({ status, onDone }) {
  const { signIn } = useAuth();
  const needAdmin = !status.adminExists;
  const [f, setF] = useState({ companyName: '', officeStart: '09:00', officeEnd: '18:00', graceMinutes: 15, halfDayHours: 5, weekendDays: [6, 7], fullName: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const body = { companyName: f.companyName, officeStart: f.officeStart, officeEnd: f.officeEnd, graceMinutes: Number(f.graceMinutes),
        halfDayHours: Number(f.halfDayHours), weekendDays: f.weekendDays };
      if (needAdmin) body.admin = { fullName: f.fullName, email: f.email, password: f.password };
      const { data } = await api.post('/setup', body);
      toast.success('Company created');
      if (data.token) await signIn(data.token);
      else toast.info('Sign in with the Admin account from the server environment.');
      onDone();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Welcome to HCM Lite" subtitle="First-run setup — create your company and Admin account" icon={Building2} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">1 · Company</h2>
          <Field label="Company name" error={errors.companyName}><input className="input" required value={f.companyName} onChange={set('companyName')} placeholder="Saylani Tech" /></Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Office start"><input type="time" className="input" value={f.officeStart} onChange={set('officeStart')} /></Field>
            <Field label="Office end"><input type="time" className="input" value={f.officeEnd} onChange={set('officeEnd')} /></Field>
            <Field label="Grace (min)"><input type="number" min="0" max="120" className="input" value={f.graceMinutes} onChange={set('graceMinutes')} /></Field>
            <Field label="Half day under (h)"><input type="number" min="1" max="12" step="0.5" className="input" value={f.halfDayHours} onChange={set('halfDayHours')} /></Field>
          </div>
          <div>
            <span className="label">Weekend</span>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(([n, d]) => (
                <label key={n} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-sm dark:border-slate-700">
                  <input type="checkbox" checked={f.weekendDays.includes(n)}
                    onChange={(e) => setF({ ...f, weekendDays: e.target.checked ? [...f.weekendDays, n].sort() : f.weekendDays.filter((x) => x !== n) })} />
                  {d}
                </label>
              ))}
            </div>
          </div>
        </div>
        {needAdmin ? (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">2 · Admin account</h2>
            <Field label="Full name" error={errors['admin.fullName']}><input className="input" required value={f.fullName} onChange={set('fullName')} /></Field>
            <Field label="Email" error={errors['admin.email']}><input type="email" className="input" required value={f.email} onChange={set('email')} /></Field>
            <Field label="Password" hint="At least 8 characters with a letter and a digit" error={errors['admin.password']}>
              <input type="password" className="input" required value={f.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
          </div>
        ) : (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">The Admin account was created from the server environment (ADMIN_EMAIL). Sign in with it after setup.</p>
        )}
        <Button type="submit" loading={busy} className="w-full">Create company</Button>
        <p className="text-center text-xs text-slate-500">You can set office location, departments, leave types and holidays next.</p>
      </form>
    </AuthFrame>
  );
}

export function Login() {
  const { signIn } = useAuth();
  const [f, setF] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/auth/login', f);
      await signIn(data.token);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Sign in" subtitle="HCM Lite — Admin, HR and Employees" icon={LogIn}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email"><input type="email" className="input" required autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" /></Field>
        <Field label="Password"><input type="password" className="input" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" /></Field>
        {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</div>}
        <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        <p className="text-center text-xs text-slate-500">New here? HR gives you a temporary password; you'll set your own at first sign-in.</p>
      </form>
    </AuthFrame>
  );
}

export function ChangePassword({ forced }) {
  const { signIn, signOut, user } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return setErrors({ confirm: 'Passwords do not match' });
    setBusy(true);
    setErrors({});
    try {
      const { data } = await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      toast.success('Password changed');
      await signIn(data.token);
      if (!forced) navigate('/dashboard');
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const form = (
    <form onSubmit={submit} className="space-y-3">
      <Field label={forced ? 'Temporary password' : 'Current password'} error={errors.currentPassword}>
        <input type="password" className="input" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} autoComplete="current-password" />
      </Field>
      <Field label="New password" hint="At least 8 characters with a letter and a digit" error={errors.newPassword}>
        <input type="password" className="input" required value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password" error={errors.confirm}>
        <input type="password" className="input" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />
      </Field>
      <Button type="submit" loading={busy} className="w-full">Change password</Button>
      {forced && <button type="button" onClick={signOut} className="w-full text-center text-xs text-slate-500 hover:underline">Sign out</button>}
    </form>
  );
  if (!forced) return <div className="card mx-auto max-w-md p-6"><h1 className="mb-4 text-lg font-semibold">Change password</h1>{form}</div>;
  return (
    <AuthFrame title="Set your password" subtitle={`Hi ${user.fullName}, replace your temporary password to continue`} icon={KeyRound}>{form}</AuthFrame>
  );
}
