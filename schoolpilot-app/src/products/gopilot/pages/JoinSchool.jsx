import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { Car, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import api from '../../../shared/utils/api';

export default function JoinSchool() {
  const { schoolSlug } = useParams();
  const navigate = useNavigate();
  const { user, refetchUser } = useGoPilotAuth();

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      navigate(`/login?redirect=${encodeURIComponent(`/gopilot/join/${schoolSlug}`)}`);
    }
  }, [user, navigate, schoolSlug]);

  useEffect(() => {
    if (user && schoolSlug && !success && !loading) {
      handleJoin();
    }
  }, [user, schoolSlug]);

  const handleJoin = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/me/join-school', { schoolSlug });
      setSuccess(res.data.school);
      await refetchUser();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to join school');
    } finally {
      setLoading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
              <Car className="w-6 h-6 text-white" />
            </div>
            <span className="text-2xl font-bold text-gray-800">GoPilot</span>
          </div>
        </div>

        {loading && (
          <div className="text-center py-8">
            <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
            <p className="text-gray-600">Joining school...</p>
          </div>
        )}

        {success && (
          <div className="text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Joined {success.name}!</h2>
            <p className="text-gray-600 mb-6">
              You're now connected to this school. Add your children using their student codes.
            </p>
            <Link
              to="/gopilot/parent"
              className="inline-block px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              Go to Parent App
            </Link>
          </div>
        )}

        {error && (
          <div className="text-center">
            <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Couldn't Join School</h2>
            <p className="text-red-600 mb-6">{error}</p>
            <button
              onClick={handleJoin}
              className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
