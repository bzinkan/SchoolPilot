import { createContext, useContext, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { PRODUCT_PRIORITY, PRODUCT_CONFIG } from '../shared/utils/constants';

const LicenseContext = createContext(null);

export function LicenseProvider({ children }) {
  const { licenses } = useAuth();

  const value = useMemo(() => {
    const hasClassPilot = !!licenses?.classPilot;
    const hasPassPilot = !!licenses?.passPilot;
    const hasGoPilot = !!licenses?.goPilot;

    const licensedProducts = [];
    if (hasClassPilot) licensedProducts.push('CLASSPILOT');
    if (hasPassPilot) licensedProducts.push('PASSPILOT');
    if (hasGoPilot) licensedProducts.push('GOPILOT');

    // Find default product by priority
    const defaultProduct = PRODUCT_PRIORITY.find((p) => licensedProducts.includes(p)) || null;
    const defaultPath = defaultProduct ? PRODUCT_CONFIG[defaultProduct].basePath : '/';

    return {
      hasClassPilot,
      hasPassPilot,
      hasGoPilot,
      licensedProducts,
      defaultProduct,
      defaultPath,
      productCount: licensedProducts.length,
    };
  }, [licenses]);

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicenses() {
  const ctx = useContext(LicenseContext);
  if (!ctx) throw new Error('useLicenses must be used within LicenseProvider');
  return ctx;
}
