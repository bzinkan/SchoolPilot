import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { passPilotClassRequest } from '../../products/passpilot/classData';

export default function PassWidget() {
  const [activeCount, setActiveCount] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const fetchCount = async () => {
      try {
        const data = await passPilotClassRequest('GET', '/passpilot/passes/active');
        if (mounted) {
          setActiveCount(data?.passes?.length ?? 0);
          setLoadError(false);
        }
      } catch {
        if (mounted) setLoadError(true);
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
      <span className="text-purple-700">{loadError ? 'Passes unavailable' : 'Active Passes'}</span>
      <span className="ml-auto rounded-full bg-purple-500 px-2 py-0.5 text-xs font-bold text-white">
        {loadError ? <span aria-label="Pass count unavailable">!</span> : activeCount}
      </span>
    </button>
  );
}
