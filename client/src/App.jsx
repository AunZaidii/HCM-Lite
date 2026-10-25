import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { useAuth } from './auth';
import AppShell from './layout';
import { ErrorState, Loading } from './ui';
import { ChangePassword, Login, Setup } from './pages/Auth';
import Dashboard, { EmployeeDashboard } from './pages/Dashboard';
import { Org, Settings, Users } from './pages/Admin';
import { Employee360, EmployeeImport, EmployeeNew, Employees, Profile } from './pages/Employees';
import { AttendanceBoard, AttendanceCalendar, Corrections } from './pages/Attendance';
import { LeaveApprovals, MyLeave } from './pages/Leave';
import { PayrollRun, PayrollRuns, Payslips } from './pages/Payroll';
import { AiLogs, Announcements, AuditLog } from './pages/Comms';
import ChatPanel from './pages/ChatPanel';

// face-api.js is large, so the camera page loads on demand.
const CameraCheckIn = lazy(() => import('./pages/Camera'));

function Guard({ roles, children }) {
  const { user } = useAuth();
  if (roles && !roles.includes(user.role)) {
    return <div className="card p-8 text-center"><h1 className="text-lg font-semibold">403 — Not allowed</h1><p className="mt-1 text-sm text-slate-500">Your role cannot open this page.</p></div>;
  }
  return children;
}

export default function App() {
  const { loading, user } = useAuth();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => get('/setup/status'), staleTime: Infinity });

  if (loading || status.isLoading) return <div className="mx-auto max-w-md p-10"><Loading rows={4} /></div>;
  if (status.isError) return <div className="mx-auto max-w-md p-10"><ErrorState error={status.error} onRetry={status.refetch} /></div>;
  if (!status.data.setupComplete) return <Setup status={status.data} onDone={() => status.refetch()} />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (user.mustChangePassword) return <ChangePassword forced />;

  const A = ['admin'];
  const AH = ['admin', 'hr'];
  const HE = ['hr', 'employee'];
  const H = ['hr'];
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="login" element={<Navigate to="/dashboard" replace />} />
        <Route path="setup" element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="me" element={<Guard roles={HE}><EmployeeDashboard /></Guard>} />
        <Route path="settings" element={<Guard roles={AH}><Settings /></Guard>} />
        <Route path="org" element={<Guard roles={AH}><Org /></Guard>} />
        <Route path="users" element={<Guard roles={A}><Users /></Guard>} />
        <Route path="employees" element={<Guard roles={AH}><Employees /></Guard>} />
        <Route path="employees/new" element={<Guard roles={H}><EmployeeNew /></Guard>} />
        <Route path="employees/import" element={<Guard roles={H}><EmployeeImport /></Guard>} />
        <Route path="employees/:id" element={<Guard roles={AH}><Employee360 /></Guard>} />
        <Route path="profile" element={<Guard roles={HE}><Profile /></Guard>} />
        <Route path="attendance" element={<Guard roles={AH}><AttendanceBoard /></Guard>} />
        <Route path="attendance/calendar" element={<AttendanceCalendar />} />
        <Route path="attendance/corrections" element={<Corrections />} />
        <Route path="attendance/camera" element={<Guard roles={HE}><Suspense fallback={<Loading rows={4} />}><CameraCheckIn /></Suspense></Guard>} />
        <Route path="leave" element={<Guard roles={HE}><MyLeave /></Guard>} />
        <Route path="leave/approvals" element={<Guard roles={AH}><LeaveApprovals /></Guard>} />
        <Route path="payroll" element={<Guard roles={AH}><PayrollRuns /></Guard>} />
        <Route path="payroll/:id" element={<Guard roles={AH}><PayrollRun /></Guard>} />
        <Route path="payslips" element={<Payslips />} />
        <Route path="announcements" element={<Announcements />} />
        <Route path="audit" element={<Guard roles={A}><AuditLog /></Guard>} />
        <Route path="ai-logs" element={<Guard roles={A}><AiLogs /></Guard>} />
        <Route path="assistant" element={<ChatPanel />} />
        <Route path="change-password" element={<ChangePassword />} />
        <Route path="*" element={<div className="card p-8 text-center"><h1 className="text-lg font-semibold">404 — Page not found</h1></div>} />
      </Route>
    </Routes>
  );
}
