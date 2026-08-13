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
    // Use gopilotRole override if set, otherwise fall back to base role
    const gopilotRole = activeMembership?.gopilotRole || role;
    // GoPilot is staff-only. Historical parent memberships remain stored but
    // no longer grant access to a GoPilot product surface.
    if (hasGoPilot && gopilotRole === 'parent' && defaultProduct === 'GOPILOT') {
      roleBasedDefaultPath = '/gopilot/unavailable';
    }
    // Teachers default into GoPilot only when GoPilot is the selected product.
    // Shared-product schools may have ClassPilot teachers without GoPilot homerooms.
    else if (hasGoPilot && defaultProduct === 'GOPILOT' && !isAdmin && gopilotRole === 'teacher') {
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
