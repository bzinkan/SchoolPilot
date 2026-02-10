import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../shared/utils/api';

export default function PassWidget() {
  const [activeCount, setActiveCount] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const fetchCount = async () => {
      try {
        const res = await api.get('/passpilot/passes/active');
        if (mounted) setActiveCount(res.data.passes?.length ?? 0);
      } catch {
        // Silently fail - widget is optional
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return (
    <button
      onClick={() => navigate('/passpilot/passes')}
      className="flex w-full items-center gap-2 rounded-md bg-purple-50 px-3 py-2 text-sm transition-colors hover:bg-purple-100"
    >
      <span>🎫</span>
      <span className="text-purple-700">Active Passes</span>
      <span className="ml-auto rounded-full bg-purple-500 px-2 py-0.5 text-xs font-bold text-white">
        {activeCount}
      </span>
    </button>
  );
}
