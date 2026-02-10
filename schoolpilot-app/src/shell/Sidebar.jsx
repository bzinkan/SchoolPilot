import { NavLink, useLocation } from 'react-router-dom';
import { useLicenses } from '../contexts/LicenseContext';
import { PRODUCT_CONFIG } from '../shared/utils/constants';
import PassWidget from './widgets/PassWidget';
import GoWidget from './widgets/GoWidget';

const NAV_ITEMS = {
  CLASSPILOT: [
    { label: 'Dashboard', path: '/classpilot', icon: '📊' },
    { label: 'Students', path: '/classpilot/students', icon: '👩‍🎓' },
    { label: 'Devices', path: '/classpilot/devices', icon: '💻' },
    { label: 'Groups', path: '/classpilot/groups', icon: '👥' },
    { label: 'Settings', path: '/classpilot/settings', icon: '⚙️' },
  ],
  PASSPILOT: [
    { label: 'Dashboard', path: '/passpilot', icon: '📊' },
    { label: 'Passes', path: '/passpilot/passes', icon: '🎫' },
    { label: 'Students', path: '/passpilot/students', icon: '👩‍🎓' },
    { label: 'Settings', path: '/passpilot/settings', icon: '⚙️' },
  ],
  GOPILOT: [
    { label: 'Dashboard', path: '/gopilot', icon: '📊' },
    { label: 'Dismissal', path: '/gopilot/dismissal', icon: '🚗' },
    { label: 'Students', path: '/gopilot/students', icon: '👩‍🎓' },
    { label: 'Homerooms', path: '/gopilot/homerooms', icon: '🏫' },
    { label: 'Settings', path: '/gopilot/settings', icon: '⚙️' },
  ],
};

export default function Sidebar({ open, onClose }) {
  const { licensedProducts, hasPassPilot, hasGoPilot } = useLicenses();
  const location = useLocation();

  // Determine active product
  const activeProduct =
    licensedProducts.find((k) =>
      location.pathname.startsWith(PRODUCT_CONFIG[k].basePath)
    ) || licensedProducts[0];

  const items = NAV_ITEMS[activeProduct] || [];
  const cfg = PRODUCT_CONFIG[activeProduct];

  // Show widgets only in ClassPilot view
  const showWidgets = activeProduct === 'CLASSPILOT';

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
        {/* Product indicator */}
        <div className={`flex items-center gap-2 border-b px-4 py-3 ${cfg?.bgClass || 'bg-slate-50'}`}>
          <span>{cfg?.icon}</span>
          <span className={`text-sm font-semibold ${cfg?.textClass || 'text-slate-700'}`}>
            {cfg?.label}
          </span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === PRODUCT_CONFIG[activeProduct]?.basePath}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? `${cfg?.bgClass || 'bg-slate-100'} ${cfg?.textClass || 'text-slate-900'} font-semibold`
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
