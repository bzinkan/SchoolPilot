import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api, { setApiToken } from '../shared/utils/api';
import { saveToken } from '../native/storage';
import Spinner from '../shared/components/Spinner';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refetchUser } = useAuth();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    // OAuth callback uses one-time code (60s TTL, single-use). Exchange it for the JWT.
    const code = searchParams.get('code');
    if (!code) {
      navigate('/login?error=no_token', { replace: true });
      return;
    }

    api.post('/auth/exchange-code', { code })
      .then((res) => {
        const token = res.data?.token;
        if (!token) {
          navigate('/login?error=oauth_failed', { replace: true });
          return;
        }
        setApiToken(token);
        saveToken(token);
        return refetchUser().then(() => {
          navigate('/login', { replace: true });
        });
      })
      .catch(() => {
        navigate('/login?error=oauth_failed', { replace: true });
      });
  }, [searchParams, navigate, refetchUser]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}
