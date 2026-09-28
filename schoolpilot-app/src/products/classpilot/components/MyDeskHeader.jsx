import { ArrowLeft } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { ThemeToggle } from '../../../components/ThemeToggle';

/** Every My Desk page shares this header: the way out on the left and the hub's name in the middle. */
export default function MyDeskHeader({ backLabel = 'ClassPilot', onBack, title = 'My Desk', className = '' }) {
  return <header className={`mydesk-header mydesk-hub-header ${className}`.trim()}>
    <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" />{backLabel}</Button>
    {title ? <p className="mydesk-hub-title">{title}</p> : <span aria-hidden="true" />}
    <ThemeToggle />
  </header>;
}
