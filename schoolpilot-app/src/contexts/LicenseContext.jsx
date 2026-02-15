import { createContext, useContext, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { PRODUCT_PRIORITY, PRODUCT_CONFIG } from '../shared/utils/constants';

const LicenseContext = createContext(null);

export function LicenseProvider({ children }) {
  const { licenses, activeMembership } = useAuth();

  const value = useMemo(() => {
    const hasClassPilot = !!licenses?.classPilot;
    const hasPassPilot = !!licenses?.passPilot;
    const hasGoPilot = !!licenses?.goPilot;

    const licensedProducts = [];
    if (hasClassPilot) licensedProducts.push('CLASSPILOT');
    if (hasPassPilot) licensedProducts.push('PASSPILOT');
    if (hasGoPilot) licensedProducts.push('GOPILOT');

    // Find default product by priority (ClassPilot > PassPilot > GoPilot)
    const defaultProduct = PRODUCT_PRIORITY.find((p) => licensedProducts.includes(p)) || null;
    const defaultPath = defaultProduct ? PRODUCT_CONFIG[defaultProduct].basePath : '/';

    // Role-aware default path
    const role = activeMembership?.role;
    const isAdmin = role === 'admin' || role === 'school_admin';
    let roleBasedDefaultPath = defaultPath;
    if (defaultProduct === 'GOPILOT' && !isAdmin && role === 'teacher') {
      roleBasedDefaultPath = '/gopilot/teacher';
    }

    return {
      hasClassPilot,
      hasPassPilot,
      hasGoPilot,
      licensedProducts,
      defaultProduct,
      defaultPath,
      roleBasedDefaultPath,
      productCount: licensedProducts.length,
    };
  }, [licenses, activeMembership]);

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLicenses() {
  const ctx = useContext(LicenseContext);
  if (!ctx) throw new Error('useLicenses must be used within LicenseProvider');
  return ctx;
}
