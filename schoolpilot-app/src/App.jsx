import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LicenseProvider, useLicenses } from './contexts/LicenseContext';
import { NativeProvider, useNative } from './contexts/NativeContext';
import { SocketProvider } from './contexts/SocketContext';
import { ThemeProvider } from './contexts/ThemeContext';
import Spinner from './shared/components/Spinner';
import { Toaster } from './components/ui/toaster';
// import { AIChatButton } from './components/chat/AIChatButton'; // AI Chat FAB — disabled, using backend-only monitoring
import Login from './pages/Login';
import Landing from './pages/Landing';
import LandingV2 from './pages/LandingV2';
import AuthCallback from './pages/AuthCallback';

// ClassPilot pages (lazy-loaded)
const CPDashboard = lazy(() => import('./products/classpilot/pages/Dashboard'));
const CPRoster = lazy(() => import('./products/classpilot/pages/Roster'));
const CPAdmin = lazy(() => import('./products/classpilot/pages/Admin'));
const CPAdminClasses = lazy(() => import('./products/classpilot/pages/AdminClasses'));
const CPAdminAnalytics = lazy(() => import('./products/classpilot/pages/AdminAnalytics'));
const CPAdminAttendance = lazy(() => import('./products/classpilot/pages/AdminAttendance'));
const CPITReadiness = lazy(() => import('./products/classpilot/pages/ITReadiness'));
const CPSafetyCenter = lazy(() => import('./products/classpilot/pages/SafetyCenter'));
const CPEmailMonitoring = lazy(() => import('./products/classpilot/pages/EmailMonitoring'));
const CPEmailMonitoringSetup = lazy(() => import('./products/classpilot/pages/EmailMonitoringSetup'));
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

// Product landing pages (lazy-loaded, public)
const ClassPilotLanding = lazy(() => import('./pages/products/ClassPilotLanding'));
const PassPilotLanding = lazy(() => import('./pages/products/PassPilotLanding'));
const GoPilotLanding = lazy(() => import('./pages/products/GoPilotLanding'));

// Get Started (lazy-loaded, public)
const GetStarted = lazy(() => import('./pages/GetStarted'));

// Legal pages (lazy-loaded, public)
const TermsOfService = lazy(() => import('./pages/legal/TermsOfService'));
const PrivacyPolicy = lazy(() => import('./pages/legal/PrivacyPolicy'));
const DeleteAccount = lazy(() => import('./pages/legal/DeleteAccount'));
const AITransparency = lazy(() => import('./pages/legal/AITransparency'));
const Subprocessors = lazy(() => import('./pages/legal/Subprocessors'));
const Security = lazy(() => import('./pages/legal/Security'));

// Super Admin pages (lazy-loaded)
const SASchoolsList = lazy(() => import('./pages/super-admin/SchoolsList'));
const SASchoolDetail = lazy(() => import('./pages/super-admin/SchoolDetail'));
const SACreateSchool = lazy(() => import('./pages/super-admin/CreateSchool'));
const SAInquiries = lazy(() => import('./pages/super-admin/Inquiries'));

function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

function ImpersonationBanner() {
  const { user, stopImpersonating } = useAuth();
  const navigate = useNavigate();
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState('');

  if (!user?.impersonating) return null;

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'this user';

  const handleStop = async () => {
    setIsStopping(true);
    setError('');
    try {
      await stopImpersonating();
      navigate('/super-admin/schools', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not stop impersonating. Please try again.');
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="fixed left-1/2 top-3 z-[1000] w-[calc(100vw-24px)] max-w-3xl -translate-x-1/2 rounded-lg border border-amber-300 bg-amber-100 px-4 py-3 text-slate-950 shadow-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">You are impersonating {displayName}</p>
          {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
        </div>
        <button
          type="button"
          onClick={handleStop}
          disabled={isStopping}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
          data-testid="button-global-stop-impersonating"
        >
          {isStopping ? 'Stopping...' : 'Stop impersonating'}
        </button>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { user, loading, activeMembership } = useAuth();
  const { hasClassPilot, hasPassPilot, hasGoPilot, roleBasedDefaultPath } = useLicenses();
  const { isNative, product } = useNative();

  const isSuperAdmin = user?.isSuperAdmin === true;
  const superAdminDefault = '/super-admin/schools';

  // On native, override default destination based on product
  let defaultDest;
  if (isNative && (product === 'gopilot' || (product === null && hasGoPilot))) {
    const gopilotRole = activeMembership?.gopilotRole || activeMembership?.role;
    if (gopilotRole === 'parent') defaultDest = '/gopilot/parent';
    else if (gopilotRole === 'teacher') defaultDest = '/gopilot/teacher';
    else defaultDest = '/gopilot';
  } else if (isNative && product === 'passpilot') {
    defaultDest = '/passpilot';
  } else {
    defaultDest = isSuperAdmin ? superAdminDefault : (roleBasedDefaultPath || '/classpilot');
  }

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
        {/* Login & OAuth callback — always accessible */}
        <Route path="/login" element={user ? <Navigate to={defaultDest} replace /> : <Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />

        {/* Web-only routes (landing pages, legal, super admin) */}
        {!isNative && (
          <>
            <Route path="/" element={<Landing />} />
            <Route path="/get-started" element={<GetStarted />} />
            <Route path="/products/classpilot" element={<ClassPilotLanding />} />
            <Route path="/products/passpilot" element={<PassPilotLanding />} />
            <Route path="/products/gopilot" element={<GoPilotLanding />} />
            <Route path="/passpilot/kiosk" element={<PPKiosk />} />
            <Route path="/passpilot/kiosk/simple" element={<PPKioskSimple />} />
            <Route path="/terms" element={<TermsOfService />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/delete-account" element={<DeleteAccount />} />
            <Route path="/ai-transparency" element={<AITransparency />} />
            <Route path="/subprocessors" element={<Subprocessors />} />
            <Route path="/security" element={<Security />} />
          </>
        )}

        {/* Super Admin — web only */}
        {!isNative && isSuperAdmin && (
          <>
            <Route path="/super-admin/schools" element={<SASchoolsList />} />
            <Route path="/super-admin/schools/new" element={<SACreateSchool />} />
            <Route path="/super-admin/schools/:id" element={<SASchoolDetail />} />
            <Route path="/super-admin/inquiries" element={<SAInquiries />} />
          </>
        )}

        {/* ClassPilot — web only (not suitable for mobile) */}
        {!isNative && hasClassPilot && (
          <>
            <Route path="/classpilot" element={<CPDashboard />} />
            <Route path="/classpilot/class/:classId" element={<CPDashboard />} />
            <Route path="/classpilot/roster" element={<CPRoster />} />
            <Route path="/classpilot/admin" element={<CPAdmin />} />
            <Route path="/classpilot/admin/classes" element={<CPAdminClasses />} />
            <Route path="/classpilot/admin/analytics" element={<CPAdminAnalytics />} />
            <Route path="/classpilot/admin/attendance" element={<CPAdminAttendance />} />
            <Route path="/classpilot/admin/it-readiness" element={<CPITReadiness />} />
            <Route path="/classpilot/admin/safety" element={<CPSafetyCenter />} />
            <Route path="/classpilot/admin/email-monitoring" element={<CPEmailMonitoring />} />
            <Route path="/classpilot/admin/email-monitoring/setup" element={<CPEmailMonitoringSetup />} />
            <Route path="/classpilot/students" element={<CPStudents />} />
            <Route path="/classpilot/settings" element={<CPSettings />} />
            <Route path="/classpilot/my-settings" element={<CPMySettings />} />
          </>
        )}

        {/* GoPilot routes — web or native (product may be null if VITE_APP_PRODUCT not set) */}
        {(!isNative || product === 'gopilot' || product === null) && (
          <>
            <Route path="/gopilot/join/:schoolSlug" element={<GPJoinSchool />} />
            <Route path="/gopilot/onboarding" element={<GPParentOnboarding />} />
            {hasGoPilot && (
              <>
                <Route path="/gopilot" element={<GPDismissalDashboard />} />
                <Route path="/gopilot/teacher" element={<GPTeacherView />} />
                <Route path="/gopilot/parent" element={<GPParentApp />} />
                <Route path="/gopilot/setup" element={<GPSetupWizard />} />
                <Route path="/gopilot/link" element={<GPLinkChild />} />
              </>
            )}
          </>
        )}

        {/* PassPilot routes — web or native passpilot app */}
        {(!isNative || product === 'passpilot') && hasPassPilot && (
          <>
            <Route path="/passpilot" element={<PPDashboard />} />
          </>
        )}

        {/* Catch-all redirect */}
        <Route path="*" element={user ? <Navigate to={defaultDest} replace /> : <Navigate to={isNative ? '/login' : '/'} replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <NativeProvider>
          <ThemeProvider>
            <AuthProvider>
              <LicenseProvider>
                <SocketProvider>
                  <ImpersonationBanner />
                  <AppRoutes />
                  <Toaster />
                  {/* <AIChatButton /> — AI Chat FAB disabled, using backend-only monitoring */}
                </SocketProvider>
              </LicenseProvider>
            </AuthProvider>
          </ThemeProvider>
        </NativeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
