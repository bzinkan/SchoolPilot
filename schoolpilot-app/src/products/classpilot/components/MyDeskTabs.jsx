import { Link, useLocation } from 'react-router-dom';
import { activeMyDeskTab, myDeskTabList } from '../lib/myDeskTabsModel';

export default function MyDeskTabs({ seatingEnabled, onNavigate, activeTab }) {
  const location = useLocation();
  const current = new URLSearchParams(location.search), scope = new URLSearchParams();
  for (const key of ['gradeLevel', 'classId']) if (current.get(key)) scope.set(key, current.get(key));
  const suffix = scope.size ? `?${scope}` : '';
  const active = activeTab ?? activeMyDeskTab(location.pathname);
  return <nav className="mydesk-tabs" aria-label="My Desk tools">
    {myDeskTabList(seatingEnabled).map(tab => <Link key={tab.key} to={tab.path + suffix} aria-current={active === tab.key ? 'page' : undefined} onClick={event => { if (onNavigate) { event.preventDefault(); onNavigate(tab.path + suffix); } }}>{tab.label}</Link>)}
  </nav>;
}
