import { NavLink, useLocation } from 'react-router-dom';

export default function MyDeskTabs({ seatingEnabled, onNavigate }) {
  const location = useLocation();
  const current = new URLSearchParams(location.search), scope = new URLSearchParams();
  for (const key of ['gradeLevel', 'classId']) if (current.get(key)) scope.set(key, current.get(key));
  const suffix = scope.size ? `?${scope}` : '';
  return <nav className="mydesk-tabs" aria-label="My Desk tools">
    {[['/classpilot/my-desk', 'Notes'], ['/classpilot/discipline-records', 'Discipline logs'], ['/classpilot/my-desk/student-information', 'Student information'], ...(seatingEnabled ? [['/classpilot/my-desk/seating', 'Seating']] : [])].map(([path, label]) => <NavLink key={path} to={path + suffix} end={label === 'Notes'} onClick={event => { if (onNavigate) { event.preventDefault(); onNavigate(path + suffix); } }}>{label}</NavLink>)}
  </nav>;
}
