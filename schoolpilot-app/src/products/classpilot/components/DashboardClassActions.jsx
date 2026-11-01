import { useRef } from 'react';
import { ChevronDown, Clock, RefreshCw } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';

export default function DashboardClassActions({ onPastSessions, onResync, resyncDisabled, admin }) {
  const afterClose = useRef(null);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="border border-chrome-control-border text-chrome-fg hover:bg-chrome-control" data-testid="button-class-actions">
        Class actions <ChevronDown className="ml-1 inline h-3 w-3" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" onCloseAutoFocus={event => {
      const action = afterClose.current;
      if (!action) return;
      afterClose.current = null;
      event.preventDefault();
      requestAnimationFrame(action);
    }}>
      {onPastSessions ? <DropdownMenuItem onSelect={() => { afterClose.current = onPastSessions; }} data-testid="button-past-sessions">
        <Clock className="mr-2 h-4 w-4" aria-hidden="true" />Past sessions
      </DropdownMenuItem> : null}
      {onResync ? <DropdownMenuItem disabled={resyncDisabled} onSelect={() => { afterClose.current = onResync; }} data-testid={admin ? 'button-admin-resync-session' : 'button-resync-session'}>
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Resync Class
      </DropdownMenuItem> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
