import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePassPilotAuth } from '../../../hooks/usePassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import {
  ArrowLeft,
  ClipboardList,
  Users,
  BookOpen,
  BarChart3,
  Settings,
  LogOut,
  Monitor,
  ScanBarcode,
  Pencil,
} from 'lucide-react';
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
  { label: 'Passes', icon: <ClipboardList className="h-5 w-5" />, id: 'passes' },
  { label: 'My Class', icon: <BookOpen className="h-5 w-5" />, id: 'myclass' },
  { label: 'Classes', icon: <Users className="h-5 w-5" />, id: 'roster' },
  { label: 'Reports', icon: <BarChart3 className="h-5 w-5" />, id: 'reports', adminOnly: true },
  { label: 'Set Up', icon: <Settings className="h-5 w-5" />, id: 'setup', adminOnly: true },
];

export default function AppShell({ children, currentTab, onTabChange }) {
  const { user, school, isAdmin, logout, refetchUser } = usePassPilotAuth();
  const { hasClassPilot } = useLicenses();
  const navigate = useNavigate();
  const [kioskNameInput, setKioskNameInput] = useState('');
  const [isKioskNameDialogOpen, setIsKioskNameDialogOpen] = useState(false);
  const [pendingKioskAction, setPendingKioskAction] = useState(null);

  const kioskName = user?.kioskName || null;

  const saveKioskName = async (name) => {
    try {
      await fetch('/api/kiosk-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kioskName: name }),
      });
      // Refresh user data so kioskName updates
      refetchUser();
    } catch {
      // ignore
    }
  };

  const handleKioskClick = (type) => {
    if (!school?.id) return;
    if (!kioskName) {
      setPendingKioskAction(type);
      setKioskNameInput('');
      setIsKioskNameDialogOpen(true);
    } else {
      const url =
        type === 'simple'
          ? `/passpilot/kiosk/simple?school=${school.id}`
          : `/passpilot/kiosk?school=${school.id}`;
      window.open(url, '_blank');
    }
  };

  const handleKioskNameSubmit = async () => {
    const name = kioskNameInput.trim();
    if (!name || !school?.id) return;
    await saveKioskName(name);
    setIsKioskNameDialogOpen(false);
    if (pendingKioskAction === 'rename') {
      setPendingKioskAction(null);
      return;
    }
    const url =
      pendingKioskAction === 'simple'
        ? `/passpilot/kiosk/simple?school=${school.id}`
        : `/passpilot/kiosk?school=${school.id}`;
    window.open(url, '_blank');
    setPendingKioskAction(null);
  };

  const visibleNav = navItems.filter((item) => !item.adminOnly || isAdmin);

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
            <button
              onClick={() => navigate('/classpilot')}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mr-1"
              title="Back to ClassPilot"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">ClassPilot</span>
            </button>
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
              <DropdownMenuItem onClick={() => handleKioskClick('simple')}>
                <Users className="mr-2 h-4 w-4" />
                Simple Kiosk{kioskName ? ` (${kioskName})` : ''}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleKioskClick('badge')}>
                <ScanBarcode className="mr-2 h-4 w-4" />
                Badge / ID Kiosk{kioskName ? ` (${kioskName})` : ''}
              </DropdownMenuItem>
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
                  {user?.role === 'school_admin' ? 'Admin' : 'Teacher'}
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
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex flex-col items-center justify-center gap-1 text-xs transition-colors ${
                  active
                    ? 'text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`button-tab-${item.id}`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Kiosk Name Dialog */}
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
