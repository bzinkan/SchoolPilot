import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { Car, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import api from '../../../shared/utils/api';

export default function LinkChild() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useGoPilotAuth();
  const code = searchParams.get('code') || '';
  const schoolSlug = searchParams.get('school') || '';

  const [relationship, setRelationship] = useState('parent');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) {
      navigate(`/login?redirect=${encodeURIComponent(`/gopilot/link?school=${schoolSlug}&code=${code}`)}`);
    }
  }, [user, navigate, code, schoolSlug]);

  const handleLink = async () => {
    if (!code) {
      setError('No student code provided');
      return;
    }
    setLoading(true);
    setError('');
    try {
      let schoolId = null;
      if (schoolSlug) {
        const joinRes = await api.post('/me/join-school', { schoolSlug });
        schoolId = joinRes.data.school?.id;
      }
      const res = await api.post('/me/children/link', { studentCode: code, relationship, schoolId });
      setSuccess(res.data.student);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to link student');
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

        {success ? (
          <div className="text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Link Request Sent!</h2>
            <p className="text-gray-600 mb-6">
              Your request to link to <strong>{success.firstName} {success.lastName}</strong> has been submitted.
              The school will review and approve it.
            </p>
            <Link
              to="/gopilot/parent"
              className="inline-block px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              Go to Parent App
            </Link>
          </div>
        ) : (
          <>
            <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">Link Your Child</h2>
            <p className="text-gray-500 text-center mb-6">
              You're linking to student code: <span className="font-mono font-bold text-indigo-600">{code}</span>
            </p>

            {error && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Your relationship to this student</label>
              <select
                value={relationship}
                onChange={e => setRelationship(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              >
                <option value="parent">Parent</option>
                <option value="guardian">Guardian</option>
                <option value="grandparent">Grandparent</option>
                <option value="other">Other</option>
              </select>
            </div>

            <button
              onClick={handleLink}
              disabled={loading || !code}
              className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}
              {loading ? 'Linking...' : 'Link My Child'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
