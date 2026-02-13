import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../shared/utils/api';

const statusColors = {
  active: 'bg-green-100 text-green-800',
  trial: 'bg-blue-100 text-blue-800',
  suspended: 'bg-red-100 text-red-800',
};

export default function SchoolDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [school, setSchool] = useState(null);
  const [loading, setLoading] = useState(true);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  // Add admin
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [adminForm, setAdminForm] = useState({ email: '', displayName: '', password: '' });
  const [adminResult, setAdminResult] = useState(null);

  // Reset login
  const [resetResult, setResetResult] = useState(null);

  const [error, setError] = useState(null);

  const loadSchool = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/super-admin/schools/${id}`);
      const data = res.data;
      setSchool(data);
      setEditForm({
        name: data.name || '',
        domain: data.domain || '',
        status: data.status || 'active',
        maxLicenses: data.maxLicenses ?? data.max_licenses ?? 100,
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSchool(); }, [id]);

  const handleSave = async () => {
    try {
      await api.patch(`/super-admin/schools/${id}`, editForm);
      setEditing(false);
      setError(null);
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update');
    }
  };

  const handleAddAdmin = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post(`/super-admin/schools/${id}/admins`, adminForm);
      setAdminResult(res.data);
      setShowAddAdmin(false);
      setAdminForm({ email: '', displayName: '', password: '' });
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add admin');
    }
  };

  const handleResetLogin = async () => {
    try {
      const res = await api.post(`/super-admin/schools/${id}/reset-login`);
      setResetResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset login');
    }
  };

  const handleImpersonate = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/impersonate`);
      window.location.href = '/';
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to impersonate');
    }
  };

  const handleSuspend = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/suspend`);
      loadSchool();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to suspend');
    }
  };

  const handleRestore = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/restore`);
      loadSchool();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to restore');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this school? This is a soft-delete.')) return;
    try {
      await api.delete(`/super-admin/schools/${id}`);
      navigate('/super-admin/schools');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  };

  if (loading) return <div className="p-6 text-center text-slate-400">Loading...</div>;
  if (!school) return <div className="p-6 text-center text-slate-400">School not found</div>;

  const admins = school.admins || (school.members || []).filter(m => m.role === 'admin');
  const teachers = school.teachers || (school.members || []).filter(m => m.role === 'teacher');
  const studentCount = school.studentCount ?? school.student_count ?? school.students ?? 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Back */}
      <button
        onClick={() => navigate('/super-admin/schools')}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-4"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back to Schools
      </button>

      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Admin added result */}
      {adminResult?.tempPassword && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="font-semibold text-green-800 mb-1">Admin added!</p>
          <p className="text-sm text-green-700">Email: {adminResult.admin?.email || adminResult.email}</p>
          <p className="text-sm text-green-700">Temp Password: <span className="font-mono">{adminResult.tempPassword}</span></p>
          <button
            onClick={() => navigator.clipboard.writeText(adminResult.tempPassword)}
            className="mt-2 flex items-center gap-1 text-sm text-green-700 hover:text-green-900"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Copy Password
          </button>
        </div>
      )}

      {/* Reset login result */}
      {resetResult && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="font-semibold text-blue-800 mb-1">Password Reset</p>
          <p className="text-sm text-blue-700">Admin: {resetResult.admin?.displayName || resetResult.admin?.email}</p>
          <p className="text-sm text-blue-700">Temp Password: <span className="font-mono text-lg select-all">{resetResult.tempPassword}</span></p>
          <button
            onClick={() => navigator.clipboard.writeText(resetResult.tempPassword)}
            className="mt-2 flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Copy Password
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{school.name}</h1>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[school.status] || 'bg-slate-100'}`}>
              {school.status}
            </span>
          </div>
          <p className="text-sm text-slate-500">{school.domain || 'No domain'}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleImpersonate}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            Impersonate
          </button>
          {school.status === 'suspended' ? (
            <button onClick={handleRestore}
              className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
              Restore
            </button>
          ) : (
            <button onClick={handleSuspend}
              className="flex items-center gap-1.5 px-3 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700">
              Suspend
            </button>
          )}
          <button onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">
            Delete
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{admins.length}</p>
          <p className="text-sm text-slate-500">Admins</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{teachers.length}</p>
          <p className="text-sm text-slate-500">Teachers</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{studentCount}</p>
          <p className="text-sm text-slate-500">Students</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* School Info */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">School Info</h2>
            {!editing ? (
              <button onClick={() => setEditing(true)} className="text-sm text-blue-600 hover:text-blue-700">Edit</button>
            ) : (
              <div className="flex gap-2">
                <button onClick={handleSave} className="text-sm text-green-600 hover:text-green-700">Save</button>
                <button onClick={() => setEditing(false)} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
              </div>
            )}
          </div>
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500">Name</label>
                <input value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Domain</label>
                <input value={editForm.domain} onChange={(e) => setEditForm({...editForm, domain: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Status</label>
                <select value={editForm.status} onChange={(e) => setEditForm({...editForm, status: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm">
                  <option value="trial">Trial</option>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500">Max Licenses</label>
                <input type="number" value={editForm.maxLicenses} onChange={(e) => setEditForm({...editForm, maxLicenses: parseInt(e.target.value) || 0})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Domain</span><span>{school.domain || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Max Licenses</span><span>{school.maxLicenses ?? school.max_licenses ?? '—'}</span></div>
              {school.trialEndsAt && (
                <div className="flex justify-between"><span className="text-slate-500">Trial Ends</span><span>{new Date(school.trialEndsAt).toLocaleDateString()}</span></div>
              )}
              <div className="flex justify-between"><span className="text-slate-500">Created</span><span>{new Date(school.createdAt || school.created_at).toLocaleDateString()}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">ID</span><span className="font-mono text-xs">{school.id?.substring(0, 8)}</span></div>
            </div>
          )}
        </div>

        {/* Admins */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Admins</h2>
            <div className="flex gap-2">
              <button onClick={handleResetLogin}
                className="text-sm text-orange-600 hover:text-orange-700">Reset Login</button>
              <button onClick={() => setShowAddAdmin(!showAddAdmin)}
                className="text-sm text-blue-600 hover:text-blue-700">Add Admin</button>
            </div>
          </div>

          {showAddAdmin && (
            <form onSubmit={handleAddAdmin} className="mb-4 p-3 bg-slate-50 rounded-lg space-y-2">
              <input
                placeholder="Email *"
                value={adminForm.email}
                onChange={(e) => setAdminForm({...adminForm, email: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
                required
              />
              <input
                placeholder="Display Name"
                value={adminForm.displayName}
                onChange={(e) => setAdminForm({...adminForm, displayName: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
              />
              <input
                placeholder="Password (optional, auto-generated)"
                type="password"
                value={adminForm.password}
                onChange={(e) => setAdminForm({...adminForm, password: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
              />
              <button type="submit"
                className="w-full px-3 py-1.5 bg-slate-900 text-white rounded text-sm font-medium hover:bg-slate-800">
                Add Admin
              </button>
            </form>
          )}

          <div className="space-y-2">
            {admins.length === 0 ? (
              <p className="text-sm text-slate-400">No admins assigned</p>
            ) : (
              admins.map((admin) => (
                <div key={admin.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{admin.displayName || admin.display_name || `${admin.first_name || ''} ${admin.last_name || ''}`.trim() || admin.email}</p>
                    <p className="text-xs text-slate-400">{admin.email}</p>
                  </div>
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">admin</span>
                </div>
              ))
            )}
          </div>

          {teachers.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-slate-500 mt-4 mb-2">Teachers ({teachers.length})</h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {teachers.map((teacher) => (
                  <div key={teacher.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{teacher.displayName || teacher.display_name || `${teacher.first_name || ''} ${teacher.last_name || ''}`.trim() || teacher.email}</p>
                      <p className="text-xs text-slate-400">{teacher.email}</p>
                    </div>
                    <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full">teacher</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
