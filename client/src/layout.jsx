import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Bot, Building2, CalendarCheck, CalendarDays, ClipboardCheck, FileText, LayoutDashboard, LogOut, Megaphone, Menu,
  Moon, Settings, ShieldCheck, Sun, UserCircle, Users, Wallet, X, Camera, ScrollText, Sparkles,
} from 'lucide-react';
import { api, get } from './api';
import { useAuth } from './auth';
import { cx, fmtDateTime } from './ui';
import ChatPanel from './pages/ChatPanel';

const MENUS = {
  admin: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/employees', label: 'Employees', icon: Users },
    { to: '/attendance', label: 'Attendance', icon: CalendarCheck },
    { to: '/attendance/corrections', label: 'Corrections', icon: ClipboardCheck },
    { to: '/leave/approvals', label: 'Leave requests', icon: CalendarDays },
    { to: '/payroll', label: 'Payroll', icon: Wallet },
    { to: '/payslips', label: 'Payslips', icon: FileText },
    { to: '/org', label: 'Organization', icon: Building2 },
    { to: '/users', label: 'Users & logins', icon: ShieldCheck },
    { to: '/settings', label: 'Company settings', icon: Settings },
    { to: '/announcements', label: 'Announcements', icon: Megaphone },
    { to: '/audit', label: 'Audit log', icon: ScrollText },
    { to: '/ai-logs', label: 'AI logs', icon: Sparkles },
    { to: '/assistant', label: 'Assistant', icon: Bot },
  ],
  hr: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/employees', label: 'Employees', icon: Users },
    { to: '/attendance', label: 'Attendance board', icon: CalendarCheck },
    { to: '/attendance/corrections', label: 'Corrections', icon: ClipboardCheck },
    { to: '/leave/approvals', label: 'Leave approvals', icon: CalendarDays },
    { to: '/payroll', label: 'Payroll', icon: Wallet },
    { to: '/payslips', label: 'Payslips', icon: FileText },
    { to: '/announcements', label: 'Announcements', icon: Megaphone },
    { to: '/org', label: 'Organization', icon: Building2 },
    { to: '/settings', label: 'Company settings', icon: Settings },
    { section: 'My space' },
    { to: '/me', label: 'My dashboard', icon: UserCircle },
    { to: '/attendance/calendar', label: 'My attendance', icon: CalendarCheck },
    { to: '/leave', label: 'My leave', icon: CalendarDays },
    { to: '/profile', label: 'My profile', icon: UserCircle },
    { to: '/assistant', label: 'Assistant', icon: Bot },
  ],
  employee: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/attendance/calendar', label: 'My attendance', icon: CalendarCheck },
    { to: '/attendance/corrections', label: 'Corrections', icon: ClipboardCheck },
    { to: '/attendance/camera', label: 'Camera check-in', icon: Camera },
    { to: '/leave', label: 'My leave', icon: CalendarDays },
    { to: '/payslips', label: 'My payslips', icon: FileText },
    { to: '/profile', label: 'My profile', icon: UserCircle },
    { to: '/announcements', label: 'Announcements', icon: Megaphone },
    { to: '/assistant', label: 'Assistant', icon: Bot },
  ],
};

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* ignore */ }
    setDark(next);
  };
  return { dark, toggle };
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications'), refetchInterval: 30000 });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = q.data?.unreadCount || 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Notifications (${unread} unread)`}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-sm font-semibold dark:border-slate-800">
            Notifications
            {unread > 0 && <button className="text-xs font-medium text-brand-700" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!q.data?.items?.length && <div className="p-6 text-center text-sm text-slate-500">No notifications yet</div>}
            {q.data?.items?.map((n) => (
              <button key={n.id} onClick={() => { api.post(`/notifications/${n.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })); setOpen(false); if (n.link) navigate(n.link); }}
                className={cx('block w-full border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800', !n.isRead && 'bg-brand-50/60 dark:bg-brand-900/10')}>
                <div className="font-medium">{n.title}</div>
                {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                <div className="mt-0.5 text-[11px] text-slate-400">{fmtDateTime(n.createdAt)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const { user, company, signOut } = useAuth();
  const { dark, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);
  const menu = MENUS[user.role];

  const nav = (
    <nav className="flex-1 space-y-0.5 no-scrollbar overflow-y-auto px-3 py-3">
      {menu.map((item, i) => item.section ? (
        <div key={i} className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{item.section}</div>
      ) : (
        <NavLink key={item.to} to={item.to} end={item.to === '/attendance'}
          className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
            isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white')}>
          <item.icon className="h-4 w-4" /> {item.label}
        </NavLink>
      ))}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col bg-ink">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 font-bold text-white">H</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">HCM Lite</div>
          <div className="truncate text-xs text-slate-400">{company?.companyName}</div>
        </div>
      </div>
      {nav}
      <div className="border-t border-white/10 p-3">
        <div className="px-3 text-sm font-medium text-white">{user.fullName}</div>
        <div className="px-3 text-xs capitalize text-slate-400">{user.role === 'hr' ? 'HR' : user.role}</div>
        <button onClick={signOut} className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button className="rounded-lg p-2 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <div className="flex-1 truncate text-sm font-medium text-slate-500">{company?.companyName}</div>
          <button onClick={() => setChatOpen(true)} className="hidden items-center gap-1.5 rounded-lg border border-violet-200 px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-50 sm:flex dark:border-violet-900 dark:text-violet-300 dark:hover:bg-violet-950">
            <Bot className="h-4 w-4" /> Ask assistant
          </button>
          <button onClick={toggle} className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Toggle dark mode">
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <Notifications />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
      {location.pathname !== '/assistant' && (
        <button onClick={() => setChatOpen(true)} className="fixed bottom-5 right-5 z-30 grid h-12 w-12 place-items-center rounded-full bg-violet-600 text-white shadow-lg hover:bg-violet-700 sm:hidden" aria-label="Ask assistant">
          <Bot className="h-6 w-6" />
        </button>
      )}
      {chatOpen && <ChatPanel floating onClose={() => setChatOpen(false)} />}
    </div>
  );
}
