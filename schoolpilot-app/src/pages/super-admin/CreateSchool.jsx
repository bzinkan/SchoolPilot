import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../shared/utils/api';

export default function CreateSchool() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [form, setForm] = useState({
    name: searchParams.get('name') || '',
    domain: searchParams.get('domain') || '',
    status: 'trial',
    maxLicenses: 100,
    trialDays: 30,
    billingEmail: '',
    firstAdminEmail: searchParams.get('email') || '',
    firstAdminName: searchParams.get('adminName') || '',
    firstAdminPassword: '',
    zipCode: searchParams.get('zipCode') || '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    setForm({ ...form, [name]: type === 'number' ? parseInt(value) || 0 : value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.domain) {
      setError('School name and domain are required');
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const res = await api.post('/super-admin/schools', form);
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Failed to create school');
    } finally {
      setSubmitting(false);
    }
  };

  // Success view
  if (result) {
    const schoolId = result.school?.id || result.id;
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">School Created!</h2>
          <p className="text-slate-500 mb-6">{form.name} has been set up successfully.</p>

          {(result.tempPassword || result.adminCreated) && form.firstAdminEmail && (
            <div className="bg-slate-50 rounded-lg p-4 mb-6 text-left">
              <h3 className="font-semibold mb-2 text-slate-900">Admin Credentials</h3>
              <p className="text-sm text-slate-600">Email: <span className="font-mono font-medium">{form.firstAdminEmail}</span></p>
              {result.tempPassword && (
                <p className="text-sm text-slate-600">Password: <span className="font-mono font-medium">{result.tempPassword}</span></p>
              )}
              <button
                onClick={() => navigator.clipboard.writeText(`Email: ${form.firstAdminEmail}\nPassword: ${result.tempPassword || '(set by admin)'}`)}
                className="mt-3 flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm hover:bg-slate-50"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                Copy Credentials
              </button>
            </div>
          )}

          <div className="flex gap-3 justify-center">
            <button onClick={() => navigate('/super-admin/schools')}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50">
              Back to Schools
            </button>
            {schoolId && (
              <button onClick={() => navigate(`/super-admin/schools/${schoolId}`)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800">
                View School
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Back */}
      <button onClick={() => navigate('/super-admin/schools')}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back to Schools
      </button>

      <h1 className="text-2xl font-bold text-slate-900 mb-6">Create School</h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* School Info */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-900 mb-4">School Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">School Name *</label>
              <input name="name" value={form.name} onChange={handleChange} required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                placeholder="Lincoln Elementary" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Google Workspace Domain *</label>
              <input name="domain" value={form.domain} onChange={handleChange} required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                placeholder="school.edu" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <select name="status" value={form.status} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                <option value="trial">Trial</option>
                <option value="active">Active</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Max Licenses</label>
              <input name="maxLicenses" type="number" value={form.maxLicenses} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
            {form.status === 'trial' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trial Days</label>
                <input name="trialDays" type="number" value={form.trialDays} onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Billing Email</label>
              <input name="billingEmail" value={form.billingEmail} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="billing@school.edu" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Zip Code</label>
              <input name="zipCode" value={form.zipCode} onChange={handleChange} maxLength={5}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="90210" />
              <p className="text-xs text-slate-400 mt-1">Used for timezone auto-detection</p>
            </div>
          </div>
        </div>

        {/* First Admin */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-900 mb-1">First Admin (Optional)</h2>
          <p className="text-sm text-slate-500 mb-4">Create the school's first admin account.</p>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Admin Email</label>
              <input name="firstAdminEmail" value={form.firstAdminEmail} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="admin@school.edu" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Admin Name</label>
              <input name="firstAdminName" value={form.firstAdminName} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="John Doe" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password (Optional)</label>
              <input name="firstAdminPassword" type="password" value={form.firstAdminPassword} onChange={handleChange}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="Leave blank for Google OAuth only" />
              <p className="text-xs text-slate-400 mt-1">If left blank, admin can only sign in with Google.</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={() => navigate('/super-admin/schools')}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50">
            Cancel
          </button>
          <button type="submit" disabled={submitting}
            className="px-6 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create School'}
          </button>
        </div>
      </form>
    </div>
  );
}
