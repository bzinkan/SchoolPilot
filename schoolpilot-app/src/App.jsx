import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LicenseProvider, useLicenses } from './contexts/LicenseContext';
import Spinner from './shared/components/Spinner';
import Layout from './shell/Layout';
import Login from './pages/Login';

// ClassPilot pages
import CPDashboard from './products/classpilot/pages/Dashboard';
import CPStudents from './products/classpilot/pages/Students';
import CPDevices from './products/classpilot/pages/Devices';
import CPGroups from './products/classpilot/pages/Groups';
import CPSettings from './products/classpilot/pages/Settings';

// PassPilot pages
import PPDashboard from './products/passpilot/pages/Dashboard';
import PPPasses from './products/passpilot/pages/Passes';
import PPStudents from './products/passpilot/pages/Students';
import PPSettings from './products/passpilot/pages/Settings';

// GoPilot pages
import GPDashboard from './products/gopilot/pages/Dashboard';
import GPDismissal from './products/gopilot/pages/Dismissal';
import GPStudents from './products/gopilot/pages/Students';
import GPHomerooms from './products/gopilot/pages/Homerooms';
import GPSettings from './products/gopilot/pages/Settings';

function AppRoutes() {
  const { user, loading } = useAuth();
  const { hasClassPilot, hasPassPilot, hasGoPilot, defaultPath } = useLicenses();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={defaultPath || '/'} replace />} />

      <Route element={<Layout />}>
        {/* ClassPilot routes */}
        {hasClassPilot && (
          <>
            <Route path="/classpilot" element={<CPDashboard />} />
            <Route path="/classpilot/students" element={<CPStudents />} />
            <Route path="/classpilot/devices" element={<CPDevices />} />
            <Route path="/classpilot/groups" element={<CPGroups />} />
            <Route path="/classpilot/settings" element={<CPSettings />} />
          </>
        )}

        {/* PassPilot routes */}
        {hasPassPilot && (
          <>
            <Route path="/passpilot" element={<PPDashboard />} />
            <Route path="/passpilot/passes" element={<PPPasses />} />
            <Route path="/passpilot/students" element={<PPStudents />} />
            <Route path="/passpilot/settings" element={<PPSettings />} />
          </>
        )}

        {/* GoPilot routes */}
        {hasGoPilot && (
          <>
            <Route path="/gopilot" element={<GPDashboard />} />
            <Route path="/gopilot/dismissal" element={<GPDismissal />} />
            <Route path="/gopilot/students" element={<GPStudents />} />
            <Route path="/gopilot/homerooms" element={<GPHomerooms />} />
            <Route path="/gopilot/settings" element={<GPSettings />} />
          </>
        )}

        {/* Default redirect */}
        <Route path="/" element={<Navigate to={defaultPath || '/login'} replace />} />
        <Route path="*" element={<Navigate to={defaultPath || '/'} replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <LicenseProvider>
          <AppRoutes />
        </LicenseProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
