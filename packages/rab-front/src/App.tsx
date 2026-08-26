import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from './features/auth/Login';
import ForgotPassword from './features/auth/ForgotPassword';
import ResetPassword from './features/auth/ResetPassword';
import SetPassword from './features/auth/SetPassword';
import Layout from './shell/Layout';
import Dashboard from './features/dashboard/Dashboard';
import Users from './features/users/Users';
import Shifts from './features/scheduling/Shifts';
import Offers from './features/offers/Offers';
import Calendar from './features/scheduling/Calendar';
import Payroll from './features/payroll/Payroll';
import Venues from './features/venues/Venues';
import AuditLog from './features/audit/AuditLog';
import UserProfile from './features/users/UserProfile';
import SettingsLayout from './features/settings/layout/SettingsLayout';
import PlatformAdminRoute from './features/settings/PlatformAdminRoute';
import ProfilePage from './features/settings/profile/ProfilePage';
import ExperiencePage from './features/settings/experience/ExperiencePage';
import AccountPage from './features/settings/account/AccountPage';
import WorkspaceGeneralPage from './features/settings/workspace/WorkspaceGeneralPage';
import WorkspaceDomainsPage from './features/settings/domains/WorkspaceDomainsPage';
import WorkspaceRolesPage from './features/settings/roles/WorkspaceRolesPage';
import AdminPanelPage from './features/settings/admin-panel/AdminPanelPage';
import AppErrorBoundary from './shared/components/AppErrorBoundary';
import NotFound from './features/errors/NotFound';

const qc = new QueryClient();

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('accessToken');
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AppErrorBoundary>
        <BrowserRouter>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/set-password" element={<RequireAuth><SetPassword /></RequireAuth>} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="users" element={<Users />} />
            <Route path="users/:id" element={<UserProfile />} />
            <Route path="shifts" element={<Shifts />} />
            <Route path="offers" element={<Offers />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="payroll" element={<Payroll />} />
            <Route path="venues" element={<Venues />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="experience" element={<ExperiencePage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="workspace" element={<WorkspaceGeneralPage />} />
              <Route path="workspace/domains" element={<WorkspaceDomainsPage />} />
              <Route path="workspace/roles" element={<WorkspaceRolesPage />} />
              <Route path="admin" element={<PlatformAdminRoute><AdminPanelPage /></PlatformAdminRoute>} />
            </Route>
          </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AppErrorBoundary>
    </QueryClientProvider>
  );
}
