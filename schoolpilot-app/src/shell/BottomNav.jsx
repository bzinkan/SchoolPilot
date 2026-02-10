import { NavLink, useLocation } from 'react-router-dom';
import { useLicenses } from '../contexts/LicenseContext';
import { PRODUCT_CONFIG } from '../shared/utils/constants';

const MOBILE_ITEMS = {
  CLASSPILOT: [
    { label: 'Home', path: '/classpilot', icon: '📊' },
    { label: 'Students', path: '/classpilot/students', icon: '👩‍🎓' },
    { label: 'Devices', path: '/classpilot/devices', icon: '💻' },
    { label: 'Settings', path: '/classpilot/settings', icon: '⚙️' },
  ],
  PASSPILOT: [
    { label: 'Home', path: '/passpilot', icon: '📊' },
    { label: 'Passes', path: '/passpilot/passes', icon: '🎫' },
    { label: 'Students', path: '/passpilot/students', icon: '👩‍🎓' },
    { label: 'Settings', path: '/passpilot/settings', icon: '⚙️' },
  ],
  GOPILOT: [
    { label: 'Home', path: '/gopilot', icon: '📊' },
    { label: 'Dismissal', path: '/gopilot/dismissal', icon: '🚗' },
    { label: 'Students', path: '/gopilot/students', icon: '👩‍🎓' },
    { label: 'Settings', path: '/gopilot/settings', icon: '⚙️' },
  ],
};

export default function BottomNav() {
  const { licensedProducts } = useLicenses();
  const location = useLocation();

  const activeProduct =
    licensedProducts.find((k) =>
      location.pathname.startsWith(PRODUCT_CONFIG[k].basePath)
    ) || licensedProducts[0];

  const items = MOBILE_ITEMS[activeProduct] || [];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-slate-200 bg-white lg:hidden">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === PRODUCT_CONFIG[activeProduct]?.basePath}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors ${
              isActive ? 'text-slate-900 font-semibold' : 'text-slate-500'
            }`
          }
        >
          <span className="text-lg">{item.icon}</span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
