import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import SetPassword from './pages/SetPassword';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Shifts from './pages/Shifts';
import Offers from './pages/Offers';
import Calendar from './pages/Calendar';
import Payroll from './pages/Payroll';
import Venues from './pages/Venues';
import AuditLog from './pages/AuditLog';
import Settings from './pages/Settings';
import UserProfile from './pages/UserProfile';

const qc = new QueryClient();

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = localStorage.getItem('accessToken');
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
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
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
