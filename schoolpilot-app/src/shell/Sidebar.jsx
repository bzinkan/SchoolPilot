import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLicenses } from '../contexts/LicenseContext';
import { PRODUCT_CONFIG } from '../shared/utils/constants';
import PassWidget from './widgets/PassWidget';
import GoWidget from './widgets/GoWidget';

const NAV_ITEMS = {
  CLASSPILOT: [
    { label: 'Dashboard', path: '/classpilot', icon: '📊' },
    { label: 'Roster', path: '/classpilot/roster', icon: '📋' },
    { label: 'My Settings', path: '/classpilot/my-settings', icon: '👤' },
    { label: 'Admin', path: '/classpilot/admin', icon: '🛡️', adminOnly: true },
    { label: 'Classes', path: '/classpilot/admin/classes', icon: '🏫', adminOnly: true },
    { label: 'Students', path: '/classpilot/students', icon: '👩‍🎓', adminOnly: true },
    { label: 'Analytics', path: '/classpilot/admin/analytics', icon: '📈', adminOnly: true },
    { label: 'Settings', path: '/classpilot/settings', icon: '⚙️', adminOnly: true },
  ],
  PASSPILOT: [
    { label: 'Dashboard', path: '/passpilot', icon: '📊' },
    { label: 'Kiosk', path: '/passpilot/kiosk', icon: '🖥️' },
  ],
  GOPILOT: [
    { label: 'Dashboard', path: '/gopilot', icon: '📊' },
    { label: 'Teacher View', path: '/gopilot/teacher', icon: '👩‍🏫' },
    { label: 'Parent App', path: '/gopilot/parent', icon: '👨‍👩‍👧' },
    { label: 'Setup', path: '/gopilot/setup', icon: '⚙️' },
  ],
};

const SUPER_ADMIN_ITEMS = [
  { label: 'Schools', path: '/super-admin/schools', icon: '🏫' },
  { label: 'Trial Requests', path: '/super-admin/trial-requests', icon: '📋' },
];

export default function Sidebar({ open, onClose }) {
  const { user, activeMembership } = useAuth();
  const { licensedProducts, hasPassPilot, hasGoPilot } = useLicenses();
  const location = useLocation();

  const isSuperAdmin = user?.isSuperAdmin === true;
  const isSuperAdminView = location.pathname.startsWith('/super-admin');
  const memberRole = activeMembership?.role;
  const isAdmin = memberRole === 'admin' || memberRole === 'school_admin';

  // Determine active product
  const activeProduct =
    licensedProducts.find((k) =>
      location.pathname.startsWith(PRODUCT_CONFIG[k].basePath)
    ) || licensedProducts[0];

  const allItems = isSuperAdminView ? SUPER_ADMIN_ITEMS : (NAV_ITEMS[activeProduct] || []);
  const items = allItems.filter((item) => !item.adminOnly || isAdmin);
  const cfg = isSuperAdminView ? null : PRODUCT_CONFIG[activeProduct];

  // Show widgets only in ClassPilot view
  const showWidgets = !isSuperAdminView && activeProduct === 'CLASSPILOT';

  return (
    <>
      {/* Overlay for mobile */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed top-14 left-0 z-30 flex h-[calc(100vh-3.5rem)] w-60 flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Product / Section indicator */}
        {isSuperAdminView ? (
          <div className="flex items-center gap-2 border-b px-4 py-3 bg-slate-900">
            <span>🛡️</span>
            <span className="text-sm font-semibold text-white">Super Admin</span>
          </div>
        ) : (
          <div className={`flex items-center gap-2 border-b px-4 py-3 ${cfg?.bgClass || 'bg-slate-50'}`}>
            <span>{cfg?.icon}</span>
            <span className={`text-sm font-semibold ${cfg?.textClass || 'text-slate-700'}`}>
              {cfg?.label}
            </span>
          </div>
        )}

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {isSuperAdmin && !isSuperAdminView && (
            <NavLink
              to="/super-admin/schools"
              onClick={onClose}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors text-slate-600 hover:bg-slate-50 hover:text-slate-900 mb-1"
            >
              <span>🛡️</span>
              <span>Super Admin</span>
            </NavLink>
          )}

          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={isSuperAdminView ? item.path === '/super-admin/schools' : item.path === PRODUCT_CONFIG[activeProduct]?.basePath}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? isSuperAdminView
                      ? 'bg-slate-100 text-slate-900 font-semibold'
                      : `${cfg?.bgClass || 'bg-slate-100'} ${cfg?.textClass || 'text-slate-900'} font-semibold`
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`
              }
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Sidebar widgets */}
        {showWidgets && (hasPassPilot || hasGoPilot) && (
          <div className="border-t px-3 py-3 space-y-2">
            {hasPassPilot && <PassWidget />}
            {hasGoPilot && <GoWidget />}
          </div>
        )}
      </aside>
    </>
  );
}
