import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../shared/utils/api';
import Spinner from '../shared/components/Spinner';
import { useNative } from '../contexts/NativeContext';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { acceptToken, refetchUser } = useAuth();
  const { isNative, product } = useNative();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    if (isNative && product === 'gopilot') {
      navigate('/login?error=native_oauth_disabled', { replace: true });
      return;
    }

    // OAuth callback uses one-time code (60s TTL, single-use). Exchange it for the JWT.
    const code = searchParams.get('code');
    if (!code) {
      navigate('/login?error=no_token', { replace: true });
      return;
    }

    api.post('/auth/exchange-code', { code })
      .then(async (res) => {
        const token = res.data?.token;
        if (!token) {
          navigate('/login?error=oauth_failed', { replace: true });
          return;
        }
        await acceptToken(token);
        await refetchUser();
        navigate('/login', { replace: true });
      })
      .catch(() => {
        navigate('/login?error=oauth_failed', { replace: true });
      });
  }, [searchParams, navigate, acceptToken, refetchUser, isNative, product]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}
