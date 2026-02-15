import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LicenseProvider, useLicenses } from './contexts/LicenseContext';
import { SocketProvider } from './contexts/SocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import Spinner from './shared/components/Spinner';
import Login from './pages/Login';
import Landing from './pages/Landing';

// ClassPilot pages (lazy-loaded)
const CPDashboard = lazy(() => import('./products/classpilot/pages/Dashboard'));
const CPRoster = lazy(() => import('./products/classpilot/pages/Roster'));
const CPAdmin = lazy(() => import('./products/classpilot/pages/Admin'));
const CPAdminClasses = lazy(() => import('./products/classpilot/pages/AdminClasses'));
const CPAdminAnalytics = lazy(() => import('./products/classpilot/pages/AdminAnalytics'));
const CPStudents = lazy(() => import('./products/classpilot/pages/Students'));
const CPSettings = lazy(() => import('./products/classpilot/pages/Settings'));
const CPMySettings = lazy(() => import('./products/classpilot/pages/MySettings'));

// PassPilot pages (lazy-loaded)
const PPDashboard = lazy(() => import('./products/passpilot/pages/Dashboard'));
const PPKiosk = lazy(() => import('./products/passpilot/pages/Kiosk'));
const PPKioskSimple = lazy(() => import('./products/passpilot/pages/KioskSimple'));

// GoPilot pages (lazy-loaded)
const GPDismissalDashboard = lazy(() => import('./products/gopilot/pages/DismissalDashboard'));
const GPTeacherView = lazy(() => import('./products/gopilot/pages/TeacherView'));
const GPParentApp = lazy(() => import('./products/gopilot/pages/ParentApp'));
const GPSetupWizard = lazy(() => import('./products/gopilot/pages/SetupWizard'));
const GPParentOnboarding = lazy(() => import('./products/gopilot/pages/ParentOnboarding'));
const GPJoinSchool = lazy(() => import('./products/gopilot/pages/JoinSchool'));
const GPLinkChild = lazy(() => import('./products/gopilot/pages/LinkChild'));

// Super Admin pages (lazy-loaded)
const SASchoolsList = lazy(() => import('./pages/super-admin/SchoolsList'));
const SASchoolDetail = lazy(() => import('./pages/super-admin/SchoolDetail'));
const SACreateSchool = lazy(() => import('./pages/super-admin/CreateSchool'));
const SATrialRequests = lazy(() => import('./pages/super-admin/TrialRequests'));

function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const { hasClassPilot, hasPassPilot, hasGoPilot, roleBasedDefaultPath } = useLicenses();

  const isSuperAdmin = user?.isSuperAdmin === true;
  const superAdminDefault = '/super-admin/schools';
  const defaultDest = isSuperAdmin ? superAdminDefault : (roleBasedDefaultPath || '/classpilot');

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Landing page — always accessible */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={user ? <Navigate to={defaultDest} replace /> : <Login />} />

        {/* GoPilot public routes (no auth required) */}
        <Route path="/gopilot/join/:schoolSlug" element={<GPJoinSchool />} />
        <Route path="/gopilot/onboarding" element={<GPParentOnboarding />} />

        {/* PassPilot Kiosk routes (standalone) */}
        {hasPassPilot && (
          <>
            <Route path="/passpilot/kiosk" element={<PPKiosk />} />
            <Route path="/passpilot/kiosk/simple" element={<PPKioskSimple />} />
          </>
        )}

        {/* Super Admin — pages have their own headers */}
        {isSuperAdmin && (
          <>
            <Route path="/super-admin/schools" element={<SASchoolsList />} />
            <Route path="/super-admin/schools/new" element={<SACreateSchool />} />
            <Route path="/super-admin/schools/:id" element={<SASchoolDetail />} />
            <Route path="/super-admin/trial-requests" element={<SATrialRequests />} />
          </>
        )}

        {/* ClassPilot — dark header built into each page */}
        {hasClassPilot && (
          <>
            <Route path="/classpilot" element={<CPDashboard />} />
            <Route path="/classpilot/class/:classId" element={<CPDashboard />} />
            <Route path="/classpilot/roster" element={<CPRoster />} />
            <Route path="/classpilot/admin" element={<CPAdmin />} />
            <Route path="/classpilot/admin/classes" element={<CPAdminClasses />} />
            <Route path="/classpilot/admin/analytics" element={<CPAdminAnalytics />} />
            <Route path="/classpilot/students" element={<CPStudents />} />
            <Route path="/classpilot/settings" element={<CPSettings />} />
            <Route path="/classpilot/my-settings" element={<CPMySettings />} />
          </>
        )}

        {/* PassPilot — uses its own AppShell */}
        {hasPassPilot && (
          <Route path="/passpilot" element={<PPDashboard />} />
        )}

        {/* GoPilot — pages have their own headers */}
        {hasGoPilot && (
          <>
            <Route path="/gopilot" element={<GPDismissalDashboard />} />
            <Route path="/gopilot/teacher" element={<GPTeacherView />} />
            <Route path="/gopilot/parent" element={<GPParentApp />} />
            <Route path="/gopilot/setup" element={<GPSetupWizard />} />
            <Route path="/gopilot/link" element={<GPLinkChild />} />
          </>
        )}

        {/* Catch-all redirect */}
        <Route path="*" element={user ? <Navigate to={defaultDest} replace /> : <Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <LicenseProvider>
              <SocketProvider>
                <AppRoutes />
              </SocketProvider>
            </LicenseProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
