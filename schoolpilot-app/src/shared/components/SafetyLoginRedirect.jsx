import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Spinner from './Spinner';
import { consumeSafetyLoginReturn, rememberSafetyLoginReturn } from '../utils/safetyLoginReturn';

export function SafetySignInRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    rememberSafetyLoginReturn(`${location.pathname}${location.search}`);
    navigate('/login', { replace: true });
  }, [location.pathname, location.search, navigate]);
  return <Spinner />;
}

/** Mounted only after App's existing school-selection gate has completed. */
export function AuthenticatedLoginRedirect({ defaultDest, canResumeSafety }) {
  const navigate = useNavigate();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const destination = consumeSafetyLoginReturn();
    navigate(canResumeSafety && destination ? destination : defaultDest, { replace: true });
  }, [canResumeSafety, defaultDest, navigate]);
  return <Spinner />;
}
