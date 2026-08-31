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
import { hasGoPilotRole } from './shared/utils/schoolRoles';
import { Toaster } from './components/ui/toaster';
import './products/classpilot/calendarHistoryGuard';
// import { AIChatButton } from './components/chat/AIChatButton'; // AI Chat FAB — disabled, using backend-only monitoring
import Login from './pages/Login';
import Landing from './pages/Landing';
import LandingV2 from './pages/LandingV2';
import AuthCallback from './pages/AuthCallback';
import GateKioskExitBoundary from './products/passpilot/components/GateKioskExitBoundary';

// ClassPilot pages (lazy-loaded)
const CPDashboard = lazy(() => import('./products/classpilot/pages/Dashboard'));
const CPRoster = lazy(() => import('./products/classpilot/pages/Roster'));
const CPAdmin = lazy(() => import('./products/classpilot/pages/Admin'));
const CPAdminClasses = lazy(() => import('./products/classpilot/pages/AdminClasses'));
const CPAdminAnalytics = lazy(() => import('./products/classpilot/pages/AdminAnalytics'));
const CPCoverage = lazy(() => import('./products/classpilot/pages/Coverage'));
const CPITReadiness = lazy(() => import('./products/classpilot/pages/ITReadiness'));
const CPSafetyCenter = lazy(() => import('./products/classpilot/pages/SafetyCenter'));
const CPEmailMonitoring = lazy(() => import('./products/classpilot/pages/EmailMonitoring'));
const CPEmailMonitoringSetup = lazy(() => import('./products/classpilot/pages/EmailMonitoringSetup'));
const CPStudents = lazy(() => import('./products/classpilot/pages/Students'));
const CPSettings = lazy(() => import('./products/classpilot/pages/Settings'));
const CPMySettings = lazy(() => import('./products/classpilot/pages/MySettings'));
const CPScheduleChanges = lazy(() => import('./products/classpilot/pages/ScheduleChanges'));
const CPAdminScheduleChanges = lazy(() => import('./products/classpilot/pages/AdminScheduleChanges'));

// PassPilot pages (lazy-loaded)
const PPDashboard = lazy(() => import('./products/passpilot/pages/Dashboard'));
const PPKiosk = lazy(() => import('./products/passpilot/pages/Kiosk'));
const PPKioskSimple = lazy(() => import('./products/passpilot/pages/KioskSimple'));

// GoPilot pages (lazy-loaded)
const GPDismissalDashboard = lazy(() => import('./products/gopilot/pages/DismissalDashboard'));
const GPTeacherView = lazy(() => import('./products/gopilot/pages/TeacherView'));
const GPSetupWizard = lazy(() => import('./products/gopilot/pages/SetupWizard'));
const GPAccessDenied = lazy(() => import('./products/gopilot/pages/GoPilotAccessDenied'));
const includeRetiredGoPilotWebRoutes = import.meta.env.VITE_APP_PRODUCT !== 'gopilot';

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
const SAMonitoring = lazy(() => import('./pages/super-admin/Monitoring'));
const SASoc2 = lazy(() => import('./pages/super-admin/Soc2'));

function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

function SchoolSelectionGate() {
  const { memberships, switchSchool, logout } = useAuth();
  const [selectingSchoolId, setSelectingSchoolId] = useState(null);
  const [error, setError] = useState('');

  const selectSchool = async (schoolId) => {
    setSelectingSchoolId(schoolId);
    setError('');
    try {
      await switchSchool(schoolId);
    } catch (selectionError) {
      setError(selectionError.response?.data?.error || 'Could not select that school. Please try again.');
      setSelectingSchoolId(null);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <h1 className="text-2xl font-semibold">Choose a school</h1>
        <p className="mt-2 text-sm text-slate-300">
          Your account belongs to more than one school. Select the school you want to work in.
        </p>
        <div className="mt-6 grid gap-3" role="list">
          {memberships.map((membership) => (
            <button
              key={membership.schoolId}
              type="button"
              onClick={() => selectSchool(membership.schoolId)}
              disabled={Boolean(selectingSchoolId)}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:border-amber-300/70 hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
            >
              <span className="block font-medium">{membership.schoolName}</span>
              <span className="mt-1 block text-xs text-slate-400">
                {(membership.roles || [membership.role]).join(', ')}
              </span>
              {selectingSchoolId === membership.schoolId && (
                <span className="mt-2 block text-xs text-amber-300">Opening school…</span>
              )}
            </button>
          ))}
        </div>
        {error && <p className="mt-4 text-sm text-red-300" role="alert">{error}</p>}
        <button type="button" onClick={logout} className="mt-6 text-sm text-slate-400 underline hover:text-white">
          Sign out
        </button>
      </section>
    </main>
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
  const { user, loading, activeMembership, schoolSelectionRequired } = useAuth();
  const { hasClassPilot, hasPassPilot, hasGoPilot, roleBasedDefaultPath } = useLicenses();
  const { isNative, product } = useNative();

  const isSuperAdmin = user?.isSuperAdmin === true;
  const superAdminDefault = '/super-admin/schools';
  const canManageGoPilot = hasGoPilotRole(activeMembership, 'admin', 'school_admin', 'office_staff');
  const canTeachGoPilot = hasGoPilotRole(activeMembership, 'teacher');
  const hasGoPilotStaffAccess = canManageGoPilot || canTeachGoPilot;

  // On native, override default destination based on product
  let defaultDest;
  if (isNative && (product === 'gopilot' || (product === null && hasGoPilot))) {
    if (!hasGoPilotStaffAccess) defaultDest = '/gopilot/unavailable';
    else if (canTeachGoPilot && !canManageGoPilot) defaultDest = '/gopilot/teacher';
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

  if (user && schoolSelectionRequired && !activeMembership) {
    return <SchoolSelectionGate />;
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
            <Route
              path="/"
              element={user && defaultDest !== '/' ? <Navigate to={defaultDest} replace /> : <Landing />}
            />
            <Route path="/get-started" element={<GetStarted />} />
            <Route path="/products/classpilot" element={<ClassPilotLanding />} />
            <Route path="/products/passpilot" element={<PassPilotLanding />} />
            <Route path="/products/gopilot" element={<GoPilotLanding />} />
            <Route
              path="/passpilot/kiosk"
              element={<GateKioskExitBoundary><PPKiosk /></GateKioskExitBoundary>}
            />
            <Route
              path="/passpilot/kiosk/simple"
              element={<GateKioskExitBoundary><PPKioskSimple /></GateKioskExitBoundary>}
            />
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
            <Route path="/super-admin/monitoring" element={<SAMonitoring />} />
            <Route path="/super-admin/soc2" element={<SASoc2 />} />
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
            <Route path="/classpilot/admin/classes/schedule-changes" element={<CPAdminScheduleChanges />} />
            <Route path="/classpilot/admin/analytics" element={<CPAdminAnalytics />} />
            <Route path="/classpilot/admin/attendance" element={<Navigate to="/classpilot/admin" replace />} />
            <Route path="/classpilot/coverage" element={<CPCoverage />} />
            <Route path="/classpilot/admin/it-readiness" element={<CPITReadiness />} />
            <Route path="/classpilot/admin/safety" element={<CPSafetyCenter />} />
            <Route path="/classpilot/admin/email-monitoring" element={<CPEmailMonitoring />} />
            <Route path="/classpilot/admin/email-monitoring/setup" element={<CPEmailMonitoringSetup />} />
            <Route path="/classpilot/students" element={<CPStudents />} />
            <Route path="/classpilot/settings" element={<CPSettings />} />
            <Route path="/classpilot/my-settings" element={<CPMySettings />} />
            <Route path="/classpilot/my-settings/schedule-changes" element={<CPScheduleChanges />} />
          </>
        )}

        {/* GoPilot routes — web or native (product may be null if VITE_APP_PRODUCT not set) */}
        {(!isNative || product === 'gopilot' || product === null) && (
          <>
            <Route path="/gopilot/unavailable" element={<GPAccessDenied />} />
            {includeRetiredGoPilotWebRoutes && !isNative && (
              <>
                <Route path="/gopilot/join/:schoolSlug" element={<GPAccessDenied />} />
                <Route path="/gopilot/onboarding" element={<GPAccessDenied />} />
                <Route path="/gopilot/parent" element={<GPAccessDenied />} />
                <Route path="/gopilot/link" element={<GPAccessDenied />} />
              </>
            )}
            {hasGoPilot && hasGoPilotStaffAccess && (
              <>
                {canManageGoPilot && <Route path="/gopilot" element={<GPDismissalDashboard />} />}
                {canTeachGoPilot && <Route path="/gopilot/teacher" element={<GPTeacherView />} />}
                {canManageGoPilot && <Route path="/gopilot/setup" element={<GPSetupWizard />} />}
              </>
            )}
          </>
        )}

        {/* PassPilot routes — web or native passpilot app */}
        {(!isNative || product === 'passpilot') && hasPassPilot && (
          <>
            <Route path="/passpilot/*" element={<PPDashboard />} />
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
