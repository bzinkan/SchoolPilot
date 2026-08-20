import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePassPilotAuth } from '../../../hooks/usePassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { passPilotClassRequest } from '../classData';
import {
  ClipboardList,
  Users,
  BookOpen,
  BarChart3,
  Settings,
  LogOut,
  Monitor,
  Pencil,
  Hash,
} from 'lucide-react';
import ClaimKioskDialog from './ClaimKioskDialog';
import { useKioskSessions } from '../useKioskSessions';
import { Avatar, AvatarFallback, AvatarImage } from '../../../components/ui/avatar';
import { Button } from '../../../components/ui/button';
import { ThemeToggle } from '../../../components/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';

const navItems = [
  { label: 'Passes', icon: <ClipboardList className="h-5 w-5" />, id: 'passes', to: '/passpilot/passes' },
  { label: 'My Class', icon: <BookOpen className="h-5 w-5" />, id: 'myclass', to: '/passpilot/my-class' },
  { label: 'Classes', icon: <Users className="h-5 w-5" />, id: 'roster', to: '/passpilot/classes' },
  { label: 'Reports', icon: <BarChart3 className="h-5 w-5" />, id: 'reports', to: '/passpilot/reports', managerOnly: true },
  { label: 'Set Up', icon: <Settings className="h-5 w-5" />, id: 'setup', to: '/passpilot/setup', adminOnly: true },
];

export default function AppShell({ children, currentTab }) {
  const { user, school, isAdmin, isSchoolwideManager, logout, refetchUser } = usePassPilotAuth();
  const { hasClassPilot, hasGoPilot } = useLicenses();
  const [kioskNameInput, setKioskNameInput] = useState('');
  const [isKioskNameDialogOpen, setIsKioskNameDialogOpen] = useState(false);
  const [pendingKioskAction, setPendingKioskAction] = useState(null);
  const [isClaimKioskDialogOpen, setIsClaimKioskDialogOpen] = useState(false);
  const { kioskSessions, legacyKioskServer } = useKioskSessions();

  const kioskName = user?.kioskName || null;

  const saveKioskName = async (name) => {
    try {
      await passPilotClassRequest('PUT', '/kiosk-config', { kioskName: name });
      // Refresh user data so kioskName updates
      refetchUser();
    } catch {
      // ignore
    }
  };

  // Self-launched kiosks are auto-claimed by the launching teacher: create a
  // session bound to them and pass it in the URL, so the kiosk never shows a
  // claim code on the teacher's own device. Falls back to a plain URL (kiosk
  // bootstraps its own unclaimed session) if the server predates sessions.
  //
  // The tab must be opened synchronously inside the click's user activation —
  // window.open after an awaited network call gets popup-blocked in stricter
  // browsers. If the popup is blocked we bail BEFORE creating a session so no
  // orphaned active sessions accumulate.
  // The kiosk style (simple vs badge) is a school-wide admin setting; the
  // kiosk page self-redirects to the school's style, so the launcher always
  // opens the simple URL and needs no style knowledge.
  const openKiosk = async (preOpenedWindow = null) => {
    const base = `/passpilot/kiosk/simple?school=${school.id}`;
    const kioskWindow = preOpenedWindow ?? window.open('', '_blank');
    if (!kioskWindow) return;
    let url = base;
    try {
      const data = await passPilotClassRequest('POST', '/passpilot/kiosk/sessions/self', {});
      if (data?.session?.id) url = `${base}&session=${encodeURIComponent(data.session.id)}`;
    } catch {
      // Older server or transient failure — the kiosk page handles both.
    }
    kioskWindow.location = url;
  };

  const handleKioskClick = () => {
    if (!school?.id) return;
    if (!kioskName) {
      setPendingKioskAction('open');
      setKioskNameInput('');
      setIsKioskNameDialogOpen(true);
    } else {
      openKiosk();
    }
  };

  const handleKioskNameSubmit = async () => {
    const name = kioskNameInput.trim();
    if (!name || !school?.id) return;
    const isRename = pendingKioskAction === 'rename';
    // Open the tab before any await so the user activation is still valid.
    const kioskWindow = isRename ? null : window.open('', '_blank');
    await saveKioskName(name);
    setIsKioskNameDialogOpen(false);
    if (isRename) {
      setPendingKioskAction(null);
      return;
    }
    await openKiosk(kioskWindow);
    setPendingKioskAction(null);
  };

  const visibleNav = navItems.filter((item) => (
    (!item.adminOnly || isAdmin)
    && (!item.managerOnly || isSchoolwideManager)
  ));

  const initials = user?.displayName
    ? user.displayName
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : user?.email?.slice(0, 2).toUpperCase() ?? '?';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="border-b bg-card px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          {hasClassPilot && (
            <Link
              to="/classpilot"
              className="px-3 py-1 rounded-md text-sm font-semibold bg-yellow-400 text-blue-900 hover:bg-yellow-300 transition-colors"
            >
              ClassPilot
            </Link>
          )}
          {hasGoPilot && (
            <Link
              to="/gopilot"
              className="px-3 py-1 rounded-md text-sm font-semibold bg-purple-600 text-white hover:bg-purple-500 transition-colors"
            >
              GoPilot
            </Link>
          )}
          <h1 className="text-2xl font-bold text-primary">PassPilot</h1>
          <div className="flex items-center space-x-2 text-sm text-muted-foreground">
            {school && <span>{school.name}</span>}
            {school && user && <span>&bull;</span>}
            {user && <span>{user.displayName || 'Teacher'}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Monitor className="h-4 w-4" />
                Kiosk Mode
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleKioskClick} data-testid="menu-open-kiosk">
                <Monitor className="mr-2 h-4 w-4" />
                Open Kiosk{kioskName ? ` (${kioskName})` : ''}
              </DropdownMenuItem>
              {!legacyKioskServer && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setIsClaimKioskDialogOpen(true)}
                    data-testid="menu-claim-kiosk"
                  >
                    <Hash className="mr-2 h-4 w-4" />
                    Claim student-device kiosk&hellip;
                  </DropdownMenuItem>
                </>
              )}
              {kioskSessions.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Active kiosks
                  </div>
                  {kioskSessions.slice(0, 4).map((session) => (
                    <DropdownMenuItem key={session.id} disabled>
                      <Monitor className="mr-2 h-4 w-4" />
                      {session.className || 'No class'} &middot; kiosk
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {kioskName && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setPendingKioskAction('rename');
                      setKioskNameInput(kioskName);
                      setIsKioskNameDialogOpen(true);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename Kiosk
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-9 w-9 rounded-full">
                <Avatar className="h-9 w-9">
                  <AvatarImage src={user?.profileImageUrl ?? undefined} />
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user?.displayName ?? user?.email}</p>
                <p className="text-xs text-muted-foreground">
                  {user?.role === 'school_admin'
                    ? 'Admin'
                    : user?.role === 'office_staff'
                      ? 'Office staff'
                      : 'Teacher'}
                </p>
              </div>
              <DropdownMenuItem onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto pb-20">{children}</main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 border-t bg-card z-40">
        <div
          className="grid h-16"
          style={{ gridTemplateColumns: `repeat(${visibleNav.length}, 1fr)` }}
        >
          {visibleNav.map((item) => {
            const active = currentTab === item.id;

            return (
              <Link
                key={item.id}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-1 text-xs transition-colors ${
                  active
                    ? 'text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`button-tab-${item.id}`}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Kiosk Name Dialog */}
      <ClaimKioskDialog
        open={isClaimKioskDialogOpen}
        onOpenChange={setIsClaimKioskDialogOpen}
      />

      <Dialog open={isKioskNameDialogOpen} onOpenChange={setIsKioskNameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingKioskAction === 'rename' ? 'Rename Kiosk' : 'Name your Kiosk'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label htmlFor="kioskNameShell">Kiosk Name</Label>
              <Input
                id="kioskNameShell"
                placeholder="e.g., Room 204, Main Hall, Front Door..."
                value={kioskNameInput}
                onChange={(e) => setKioskNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleKioskNameSubmit();
                }}
                autoFocus
              />
            </div>
            <div className="flex justify-end space-x-2">
              <Button variant="outline" onClick={() => setIsKioskNameDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleKioskNameSubmit} disabled={!kioskNameInput.trim()}>
                {pendingKioskAction === 'rename' ? 'Save' : 'Open Kiosk'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
