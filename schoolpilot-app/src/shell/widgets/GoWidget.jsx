import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../shared/utils/api';

export default function GoWidget() {
  const [sessionInfo, setSessionInfo] = useState(null);
  const [countdown, setCountdown] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const fetchSession = async () => {
      try {
        const res = await api.get('/gopilot/dismissal/sessions/active');
        if (mounted && res.data) setSessionInfo(res.data);
      } catch {
        // No active session
      }
    };
    fetchSession();
    const interval = setInterval(fetchSession, 60000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!sessionInfo?.scheduledTime) return;
    const update = () => {
      const diff = new Date(sessionInfo.scheduledTime).getTime() - Date.now();
      if (diff <= 0) {
        setCountdown('Now');
        return;
      }
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      setCountdown(hrs > 0 ? `${hrs}h ${m}m` : `${m}m`);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, [sessionInfo]);

  if (!sessionInfo) return null;

  return (
    <button
      onClick={() => navigate('/gopilot/dismissal')}
      className="flex w-full items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm transition-colors hover:bg-blue-100"
    >
      <span>🚗</span>
      <span className="text-blue-700">Dismissal</span>
      {countdown && (
        <span className="ml-auto rounded-full bg-blue-500 px-2 py-0.5 text-xs font-bold text-white">
          {countdown}
        </span>
      )}
    </button>
  );
}
