import { useEffect } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, Sparkles, X } from 'lucide-react';
import { errMsg } from './api';

export const cx = clsx;

export const pkr = (n) => (n === null || n === undefined ? '—' : `PKR ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
export const pkr2 = (n) => (n === null || n === undefined ? '—' : `PKR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }) : '—');
export const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }) : '—');
export const monthName = (m) => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '');
export const todayStr = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);

export function Button({ variant = 'primary', size = 'md', loading, className, children, ...props }) {
  return (
    <button
      {...props}
      disabled={loading || props.disabled}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-brand-700 text-white hover:bg-brand-800',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ title, actions, className, children, bodyClass }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, error, hint, children, className }) {
  return (
    <label className={cx('block', className)}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Kpi({ label, value, sub, tone = 'brand', icon: Icon }) {
  const tones = {
    brand: 'text-brand-700 dark:text-brand-500', amber: 'text-amber-600', violet: 'text-violet-600', red: 'text-red-600', blue: 'text-blue-600', slate: 'text-slate-700 dark:text-slate-200',
  };
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-xs font-medium text-slate-500">
        {label}
        {Icon && <Icon className="h-4 w-4" />}
      </div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value ?? '—'}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const STATUS = {
  present: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  finalized: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  late: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  probation: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  draft: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  half_day: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  absent: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  terminated: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  on_leave: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  missing_checkout: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
};

export function Badge({ status, children, className }) {
  const label = children ?? String(status || '').replace(/_/g, ' ');
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
      STATUS[status] || 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', className)}>
      {label}
    </span>
  );
}

export const AiBadge = () => (
  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
    <Sparkles className="h-3 w-3" /> AI-generated
  </span>
);

export function Loading({ rows = 3 }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />)}
    </div>
  );
}

export function Empty({ title = 'Nothing here yet', children, icon: Icon = Inbox }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-slate-500">
      <Icon className="h-8 w-8 text-slate-300 dark:text-slate-600" />
      <div className="font-medium text-slate-700 dark:text-slate-300">{title}</div>
      {children && <div className="max-w-sm">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
      <AlertTriangle className="h-7 w-7 text-red-500" />
      <div className="text-red-700 dark:text-red-400">{errMsg(error)}</div>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// Renders loading / error / empty / content for a react-query result.
export function QueryState({ q, empty, isEmpty, children, rows }) {
  if (q.isLoading) return <Loading rows={rows} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (isEmpty?.(q.data)) return empty ?? <Empty />;
  return children(q.data);
}

export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        className={cx('card max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

export function Table({ children }) {
  return <div className="-mx-4 overflow-x-auto px-4"><table className="table">{children}</table></div>;
}

export function Select({ options, placeholder, ...props }) {
  return (
    <select className="input" {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// Shows a temporary password exactly once with a copy button.
export function TempPasswordModal({ data, onClose }) {
  if (!data) return null;
  return (
    <Modal open title="Login created" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-sm text-slate-600 dark:text-slate-300">Share these sign-in details with <b>{data.name}</b>. The temporary password is shown only once; they must change it at first sign-in.</p>
      <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 font-mono text-sm dark:bg-slate-800">
        <div>Email: {data.email}</div>
        <div className="flex items-center justify-between gap-2">
          <span>Password: <b>{data.password}</b></span>
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(data.password)}>Copy</Button>
        </div>
      </div>
    </Modal>
  );
}
