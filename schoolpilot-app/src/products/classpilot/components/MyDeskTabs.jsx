import { NavLink } from 'react-router-dom';

export default function MyDeskTabs({ seatingEnabled, onNavigate }) {
  return <nav className="mydesk-tabs" aria-label="My Desk tools">
    {[['/classpilot/my-desk', 'Notes'], ['/classpilot/my-desk/students', 'Student logs'], ...(seatingEnabled ? [['/classpilot/my-desk/seating', 'Seating']] : []), ['/classpilot/discipline-records', 'Submitted records']].map(([path, label]) => <NavLink key={path} to={path} end={label === 'Notes'} onClick={event => { if (onNavigate) { event.preventDefault(); onNavigate(path); } }}>{label}</NavLink>)}
  </nav>;
}
