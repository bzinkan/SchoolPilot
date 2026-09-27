import { useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, LogOut, Menu, School } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useClassPilotAuth } from '../../../../hooks/useClassPilotAuth';
import { ThemeToggle } from '../../../../components/ThemeToggle';
import { Button } from '../../../../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '../../../../components/ui/sheet';
import { useAdminNavigation } from '../../hooks/useAdminNavigation';
import { ADMIN_NAVIGATION, adminIdentityKey, adminLegacyDestination, adminNavigationTarget, adminRoute } from '../../lib/adminNavigation';
import AdminNavigationProvider from './AdminNavigationProvider';

function Navigation({ active, emailEnabled, mobile = false }) {
  const location = useLocation();
  const [expanded, setExpanded] = useState({ key: location.key, groups: {} });
  return <nav aria-label={mobile ? 'Admin mobile navigation' : 'Admin navigation'} className="space-y-2 px-3 py-5">
    {ADMIN_NAVIGATION.map((group, index) => {
      const grouped = group.items.length > 1;
      const open = !grouped || ((expanded.key === location.key ? expanded.groups[group.label] : undefined) ?? group.items.some(item => item.id === active));
      const panelId = `admin-${mobile ? 'mobile' : 'desktop'}-group-${index}`;
      return <div key={group.label}>
      {grouped && <button type="button" aria-expanded={open} aria-controls={panelId}
        onClick={() => setExpanded(previous => ({ key: location.key, groups: { ...(previous.key === location.key ? previous.groups : {}), [group.label]: !open } }))}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-semibold text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-slate-300 dark:hover:bg-slate-800">{group.label}<ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" /></button>}
      <ul id={panelId} hidden={!open} className={`space-y-0.5 ${grouped ? 'mb-3 ml-2 border-l pl-1' : ''}`}>{group.items.filter(item => !item.emailOnly || emailEnabled).map(item => {
        const target = adminNavigationTarget(item, location);
        return <li key={item.id}>
        <Link to={target} state={target.state} aria-current={active === item.id ? 'page' : undefined}
          className={`block rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === item.id ? 'bg-slate-900 font-semibold text-white dark:bg-slate-100 dark:text-slate-950' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'}`}>{item.label}</Link>
      </li>; })}</ul>
    </div>; })}
  </nav>;
}

export function AdminShellFrame({ route, schoolName, displayName, emailEnabled, onLogout, children }) {
  const location = useLocation();
  const [menu, setMenu] = useState({ key: location.key, open: false });
  const menuOpen = menu.key === location.key && menu.open;
  const setMenuOpen = open => setMenu({ key: location.key, open });
  const navigation = useAdminNavigation();
  const group = ADMIN_NAVIGATION.find(item => item.items.some(page => page.id === route.id));
  return <div className="min-h-screen bg-slate-50/70 text-slate-950 dark:bg-slate-950 dark:text-slate-50" data-testid="classpilot-admin-shell">
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 overflow-y-auto border-r bg-white dark:bg-slate-900 lg:block print:hidden">
      <div className="flex items-center gap-3 border-b px-6 py-5"><School className="h-5 w-5" aria-hidden="true" /><span className="text-sm font-semibold tracking-tight">Admin Panel</span></div>
      <Navigation active={route.id} emailEnabled={emailEnabled} />
    </aside>
    <div className="min-w-0 lg:pl-60 print:pl-0">
      <header className="border-b bg-white dark:bg-slate-900 print:hidden">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6 lg:px-8">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild><Button variant="outline" size="sm" className="lg:hidden"><Menu className="mr-2 h-4 w-4" />Admin menu</Button></SheetTrigger>
            <SheetContent side="left" className="w-[min(300px,calc(100vw-2rem))] overflow-y-auto p-0">
              <SheetHeader className="border-b px-6 py-5 text-left"><SheetTitle>Admin Panel</SheetTitle><SheetDescription>{schoolName || 'School administration'}</SheetDescription></SheetHeader>
              <Navigation mobile active={route.id} emailEnabled={emailEnabled} />
            </SheetContent>
          </Sheet>
          <div className="order-first w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"><p className="truncate text-xs font-medium text-muted-foreground">{schoolName || 'School administration'}</p><h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{route.title}</h1></div>
          <Button variant="ghost" size="sm" className="shrink-0" aria-label="Back to ClassPilot" title="Back to ClassPilot" onClick={() => { void navigation.navigate('/classpilot'); }}><ArrowLeft className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">Back to ClassPilot</span></Button>
          <div className="flex items-center gap-2"><span className="hidden max-w-32 truncate text-xs text-muted-foreground xl:block">{displayName}</span><ThemeToggle />
            {onLogout && <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => { void navigation.requestAction(onLogout, { id: 'logout' }); }}><LogOut className="h-4 w-4" /></Button>}
          </div>
        </div>
      </header>
      <main id="admin-main" className="mx-auto min-w-0 max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground print:hidden"><Link to="/classpilot/admin" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Admin Panel</Link><ChevronRight className="h-3 w-3" aria-hidden="true" />{group?.items.length > 1 && <><span>{group.label}</span><ChevronRight className="h-3 w-3" aria-hidden="true" /></>}<span aria-current="page">{route.title}</span></nav>
        {children}
      </main>
    </div>
  </div>;
}

export function AdminLegacyRedirect() {
  const location = useLocation();
  const destination = adminLegacyDestination(location);
  return destination ? <Navigate replace to={destination} state={destination.state} /> : <Outlet />;
}

export default function ClassPilotAdminLayout() {
  const location = useLocation();
  const { user, activeMembership, activeSchoolId } = useAuth();
  const { currentUser, school, isAdmin, logout } = useClassPilotAuth();
  const route = adminRoute(location);
  const redirect = adminLegacyDestination(location);
  if (redirect) return <Navigate replace to={redirect} state={redirect.state} />;
  // The marker controls presentation only. Teacher and shared-record access
  // continues through the same page/API boundaries without an admin wrapper.
  if (!route || !(isAdmin || currentUser?.isSuperAdmin)) return <Outlet />;
  const scopeKey = adminIdentityKey(user, activeMembership, activeSchoolId);
  return <AdminNavigationProvider key={scopeKey} scopeKey={scopeKey}>
    <AdminShellFrame route={route} schoolName={school?.name} displayName={currentUser?.displayName}
      emailEnabled={currentUser?.mailpilotEntitled} onLogout={logout}><Outlet /></AdminShellFrame>
  </AdminNavigationProvider>;
}
