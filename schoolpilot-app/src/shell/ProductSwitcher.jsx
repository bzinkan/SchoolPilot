import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLicenses } from '../contexts/LicenseContext';
import { PRODUCT_CONFIG } from '../shared/utils/constants';

export default function ProductSwitcher() {
  const { licensedProducts, productCount } = useLicenses();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Don't render if only 1 product
  if (productCount < 2) return null;

  // Determine current product from URL
  const currentKey =
    licensedProducts.find((k) =>
      location.pathname.startsWith(PRODUCT_CONFIG[k].basePath)
    ) || licensedProducts[0];
  const current = PRODUCT_CONFIG[currentKey];

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 transition-colors"
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <svg className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-48 rounded-md bg-white shadow-lg ring-1 ring-black/5">
          {licensedProducts.map((key) => {
            const cfg = PRODUCT_CONFIG[key];
            const isActive = key === currentKey;
            return (
              <button
                key={key}
                onClick={() => {
                  navigate(cfg.basePath);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-slate-100 font-semibold text-slate-900' : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span>{cfg.icon}</span>
                <span>{cfg.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
