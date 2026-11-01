import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, Palette, User } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';

export default function DashboardAccountMenu({ user, onSignOut, pending }) {
  const signOutAfterClose = useRef(false);
  const name = user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Your account';
  const initials = [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join('');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="dashboard-account-trigger" aria-label="Account menu" title={name} data-testid="button-dashboard-account">
          {initials ? <span aria-hidden="true">{initials}</span> : <User className="h-5 w-5" aria-hidden="true" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]"
        onCloseAutoFocus={event => {
          if (!signOutAfterClose.current) return;
          signOutAfterClose.current = false;
          event.preventDefault();
          requestAnimationFrame(onSignOut);
        }}>
        <DropdownMenuLabel className="break-words">{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild data-testid="account-appearance">
          <Link to="/classpilot/my-settings?section=appearance"><Palette className="mr-2 h-4 w-4" aria-hidden="true" />Appearance</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={() => { signOutAfterClose.current = true; }} data-testid="button-logout">
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />{pending ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
