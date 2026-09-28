import { Landmark, LockKeyhole } from 'lucide-react';

/** States who can see a My Desk area: only the teacher, or the school. */
export default function MyDeskVisibility({ kind = 'private', children }) {
  const school = kind === 'school';
  const Icon = school ? Landmark : LockKeyhole;
  return <div className="mydesk-visibility">
    <span className={`mydesk-visibility-badge ${school ? 'is-school' : 'is-private'}`}><Icon className="size-3.5" aria-hidden="true" />{school ? 'School record' : 'Private'}</span>
    {children && <span className="mydesk-visibility-note">{children}</span>}
  </div>;
}
