import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { setApiToken } from '../shared/utils/api';
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

    const token = searchParams.get('token');
    if (token) {
      setApiToken(token);
      saveToken(token);
      refetchUser().then(() => {
        // Navigate to /login which auto-redirects authenticated users to their dashboard
        navigate('/login', { replace: true });
      });
    } else {
      navigate('/login?error=no_token', { replace: true });
    }
  }, [searchParams, navigate, refetchUser]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}
