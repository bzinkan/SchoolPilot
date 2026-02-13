import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../shared/utils/api';

const statusColors = {
  active: 'bg-green-100 text-green-800',
  trial: 'bg-blue-100 text-blue-800',
  suspended: 'bg-red-100 text-red-800',
};

export default function SchoolsList() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [schools, setSchools] = useState([]);
  const [stats, setStats] = useState({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [productFilter, setProductFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionMenu, setActionMenu] = useState(null);
  const actionRef = useRef(null);

  // Broadcast email state
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastSubject, setBroadcastSubject] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [adminEmailInfo, setAdminEmailInfo] = useState(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const params = {};
      if (search) params.search = search;
      if (statusFilter !== 'all') params.status = statusFilter;

      const [schoolsRes, statsRes] = await Promise.all([
        api.get('/super-admin/schools', { params }),
        api.get('/super-admin/stats'),
      ]);
      setSchools(schoolsRes.data.schools || schoolsRes.data || []);
      setStats(statsRes.data);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [statusFilter]);

  // Close action menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (actionRef.current && !actionRef.current.contains(e.target)) setActionMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    loadData();
  };

  const handleSuspend = async (id) => {
    try {
      await api.post(`/super-admin/schools/${id}/suspend`);
      setActionMenu(null);
      loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to suspend school');
    }
  };

  const handleRestore = async (id) => {
    try {
      await api.post(`/super-admin/schools/${id}/restore`);
      setActionMenu(null);
      loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to restore school');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this school? This is a soft-delete and can be undone.')) return;
    try {
      await api.delete(`/super-admin/schools/${id}`);
      setActionMenu(null);
      loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete school');
    }
  };

  const handleImpersonate = async (id) => {
    try {
      await api.post(`/super-admin/schools/${id}/impersonate`);
      window.location.href = '/';
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to impersonate');
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastSubject || !broadcastMessage) return;
    setBroadcastSending(true);
    try {
      const res = await api.post('/super-admin/broadcast-email', {
        subject: broadcastSubject,
        message: broadcastMessage,
      });
      alert(`Email sent to ${res.data.sent} admin(s)`);
      setBroadcastOpen(false);
      setBroadcastSubject('');
      setBroadcastMessage('');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to send broadcast');
    } finally {
      setBroadcastSending(false);
    }
  };

  const openBroadcast = async () => {
    setBroadcastOpen(true);
    try {
      const res = await api.get('/super-admin/admin-emails');
      setAdminEmailInfo(res.data);
    } catch { /* ignore */ }
  };

  const filteredSchools = productFilter
    ? schools.filter((s) => s.products && s.products.includes(productFilter))
    : schools;

  const statCards = [
    { label: 'Total Schools', value: stats.totalSchools ?? stats.total_schools ?? 0, color: 'bg-slate-100 text-slate-700' },
    { label: 'Active', value: stats.activeSchools ?? stats.active_schools ?? stats.active ?? 0, color: 'bg-green-100 text-green-700' },
    { label: 'Trial', value: stats.trialSchools ?? stats.trial_schools ?? stats.trial ?? 0, color: 'bg-blue-100 text-blue-700' },
    { label: 'Suspended', value: stats.suspendedSchools ?? stats.suspended_schools ?? stats.suspended ?? 0, color: 'bg-red-100 text-red-700' },
    { label: 'Total Students', value: stats.totalStudents ?? stats.total_students ?? 0, color: 'bg-purple-100 text-purple-700' },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schools Management</h1>
          <p className="text-sm text-slate-500 mt-1">Manage all schools and their configurations</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openBroadcast}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            Broadcast
          </button>
          <button
            onClick={() => navigate('/super-admin/trial-requests')}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            Trial Requests
          </button>
          <button
            onClick={() => navigate('/super-admin/schools/new')}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Create School
          </button>
          <button
            onClick={async () => { await logout(); navigate('/'); }}
            className="flex items-center gap-1.5 px-3 py-2 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            Log Out
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {statCards.map((card) => (
          <div key={card.label} className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-2xl font-bold text-slate-900">{card.value}</p>
            <p className="text-xs text-slate-500 mt-1">{card.label}</p>
          </div>
        ))}
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-3 mb-4">
        <form onSubmit={handleSearch} className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            placeholder="Search schools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </form>
        <div className="flex gap-1">
          {[
            { key: 'CLASSPILOT', label: 'ClassPilot', bg: 'bg-amber-400', text: 'text-slate-900', ring: 'ring-amber-500' },
            { key: 'PASSPILOT', label: 'PassPilot', bg: 'bg-indigo-500', text: 'text-white', ring: 'ring-indigo-600' },
            { key: 'GOPILOT', label: 'GoPilot', bg: 'bg-blue-600', text: 'text-white', ring: 'ring-blue-700' },
          ].map((p) => (
            <button
              key={p.key}
              onClick={() => setProductFilter(productFilter === p.key ? null : p.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${p.bg} ${p.text} ${
                productFilter === p.key ? `ring-2 ${p.ring} ring-offset-1 opacity-100` : 'opacity-60 hover:opacity-80'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {['all', 'active', 'trial', 'suspended'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                statusFilter === s ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Schools Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left p-4 text-sm font-medium text-slate-500">School</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Products</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Status</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Admins</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Teachers</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Students</th>
              <th className="text-left p-4 text-sm font-medium text-slate-500">Created</th>
              <th className="w-12 p-4"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={8} className="p-8 text-center text-slate-400">Loading...</td></tr>
            ) : filteredSchools.length === 0 ? (
              <tr><td colSpan={8} className="p-8 text-center text-slate-400">No schools found</td></tr>
            ) : (
              filteredSchools.map((school) => (
                <tr key={school.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4">
                    <button
                      onClick={() => navigate(`/super-admin/schools/${school.id}`)}
                      className="font-medium text-slate-900 hover:text-blue-600"
                    >
                      {school.name}
                    </button>
                    {school.domain && <p className="text-xs text-slate-400">{school.domain}</p>}
                  </td>
                  <td className="p-4">
                    <div className="flex gap-1 flex-wrap">
                      {(school.products || []).includes('CLASSPILOT') && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-400 text-slate-900">CP</span>
                      )}
                      {(school.products || []).includes('PASSPILOT') && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500 text-white">PP</span>
                      )}
                      {(school.products || []).includes('GOPILOT') && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-600 text-white">GP</span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[school.status] || 'bg-slate-100 text-slate-800'}`}>
                      {school.status}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-slate-600">{school.adminCount ?? school.admin_count ?? 0}</td>
                  <td className="p-4 text-sm text-slate-600">{school.teacherCount ?? school.teacher_count ?? 0}</td>
                  <td className="p-4 text-sm text-slate-600">{school.studentCount ?? school.student_count ?? 0}</td>
                  <td className="p-4 text-sm text-slate-400">
                    {new Date(school.createdAt || school.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-4 relative" ref={actionMenu === school.id ? actionRef : null}>
                    <button
                      onClick={() => setActionMenu(actionMenu === school.id ? null : school.id)}
                      className="p-1.5 hover:bg-slate-100 rounded"
                    >
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
                    </button>
                    {actionMenu === school.id && (
                      <div className="absolute right-4 top-12 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-10 w-48">
                        <button onClick={() => { navigate(`/super-admin/schools/${school.id}`); setActionMenu(null); }}
                          className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 text-slate-700">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                          View Details
                        </button>
                        <button onClick={() => handleImpersonate(school.id)}
                          className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 text-slate-700">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                          Impersonate Admin
                        </button>
                        <div className="border-t border-slate-100 my-1"></div>
                        {school.status === 'suspended' ? (
                          <button onClick={() => handleRestore(school.id)}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 text-green-600">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /></svg>
                            Restore
                          </button>
                        ) : (
                          <button onClick={() => handleSuspend(school.id)}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 text-orange-600">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Suspend
                          </button>
                        )}
                        <button onClick={() => handleDelete(school.id)}
                          className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50 text-red-600">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Broadcast Email Modal */}
      {broadcastOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 m-4">
            <h2 className="text-lg font-semibold mb-1">Broadcast Email to All Admins</h2>
            <p className="text-sm text-slate-500 mb-4">Send an email to all school administrators.</p>
            {adminEmailInfo && (
              <div className="p-3 bg-slate-50 rounded-lg text-sm mb-4">
                <p className="font-medium">Recipients: {adminEmailInfo.totalAdmins} admin(s)</p>
                <p className="text-slate-500">Across {adminEmailInfo.schoolCount} school(s)</p>
              </div>
            )}
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
                <input
                  value={broadcastSubject}
                  onChange={(e) => setBroadcastSubject(e.target.value)}
                  placeholder="Important announcement"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Message</label>
                <textarea
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  placeholder="Write your message..."
                  rows={5}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBroadcastOpen(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={handleBroadcast}
                disabled={broadcastSending || !broadcastSubject || !broadcastMessage}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
              >
                {broadcastSending ? 'Sending...' : 'Send to All Admins'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
