import { NavLink } from 'react-router-dom';

export default function MyDeskTabs({ seatingEnabled, onNavigate }) {
  if (!seatingEnabled) return null;
  return <nav className="mydesk-tabs" aria-label="My Desk tools">
    {[['/classpilot/my-desk', 'Notes'], ['/classpilot/my-desk/seating', 'Seating']].map(([path, label]) => <NavLink key={path} to={path} end={label === 'Notes'} onClick={event => { if (onNavigate) { event.preventDefault(); onNavigate(path); } }}>{label}</NavLink>)}
  </nav>;
}
