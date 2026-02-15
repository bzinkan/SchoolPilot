import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../../components/ThemeToggle';
import api from '../../shared/utils/api';

const statusColors = {
  pending: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  converted: 'bg-green-100 text-green-800',
  declined: 'bg-red-100 text-red-800',
};

export default function TrialRequests() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  // Notes editing
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesValue, setNotesValue] = useState('');

  const loadRequests = async () => {
    try {
      setLoading(true);
      const params = {};
      if (statusFilter !== 'all') params.status = statusFilter;
      const res = await api.get('/super-admin/trial-requests', { params });
      setRequests(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRequests(); }, [statusFilter]);

  const filteredRequests = requests.filter((req) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (req.schoolName || req.school_name || '').toLowerCase().includes(q) ||
      (req.adminEmail || req.contact_email || '').toLowerCase().includes(q) ||
      (req.schoolDomain || req.domain || '').toLowerCase().includes(q)
    );
  });

  const statusCounts = {
    pending: requests.filter(r => r.status === 'pending').length,
    contacted: requests.filter(r => r.status === 'contacted').length,
    converted: requests.filter(r => r.status === 'converted').length,
    declined: requests.filter(r => r.status === 'declined').length,
  };

  const handleUpdateStatus = async (id, status) => {
    try {
      await api.patch(`/super-admin/trial-requests/${id}`, { status });
      loadRequests();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update');
    }
  };

  const handleSaveNotes = async (id) => {
    try {
      await api.patch(`/super-admin/trial-requests/${id}`, { notes: notesValue });
      setEditingNotes(null);
      loadRequests();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to save notes');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this trial request?')) return;
    try {
      await api.delete(`/super-admin/trial-requests/${id}`);
      loadRequests();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleConvert = (request) => {
    const name = request.schoolName || request.school_name || '';
    const domain = request.schoolDomain || request.domain || '';
    const email = request.adminEmail || request.contact_email || '';
    const adminName = request.adminFirstName
      ? `${request.adminFirstName} ${request.adminLastName || ''}`
      : request.contact_name || '';
    const zipCode = request.zipCode || '';

    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (domain) params.set('domain', domain);
    if (email) params.set('email', email);
    if (adminName) params.set('adminName', adminName.trim());
    if (zipCode) params.set('zipCode', zipCode);

    navigate(`/super-admin/schools/new?${params.toString()}`);
  };

  const getName = (req) =>
    req.schoolName || req.school_name || 'Unknown';

  const getContact = (req) =>
    req.adminFirstName
      ? `${req.adminFirstName} ${req.adminLastName || ''}`
      : req.contact_name || '';

  const getEmail = (req) =>
    req.adminEmail || req.contact_email || '';

  const getStudents = (req) =>
    req.estimatedStudents || req.estimated_students || '';

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back + Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/super-admin/schools')}
            className="p-2 hover:bg-slate-100 rounded-lg">
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Trial Requests</h1>
            <p className="text-sm text-slate-500">Review and manage incoming trial requests</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { key: 'pending', label: 'Pending', color: 'text-yellow-600', bg: 'bg-yellow-50' },
          { key: 'contacted', label: 'Contacted', color: 'text-blue-600', bg: 'bg-blue-50' },
          { key: 'converted', label: 'Converted', color: 'text-green-600', bg: 'bg-green-50' },
          { key: 'declined', label: 'Declined', color: 'text-red-600', bg: 'bg-red-50' },
        ].map((s) => (
          <button
            key={s.key}
            onClick={() => setStatusFilter(statusFilter === s.key ? 'all' : s.key)}
            className={`rounded-xl border p-4 text-left transition-all ${
              statusFilter === s.key ? 'ring-2 ring-slate-400 border-slate-400' : 'border-slate-200 hover:border-slate-300'
            } ${s.bg}`}
          >
            <p className={`text-2xl font-bold ${s.color}`}>{statusCounts[s.key]}</p>
            <p className="text-xs text-slate-500">{s.label}</p>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            placeholder="Search by school name, email, or domain..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {['all', 'pending', 'contacted', 'converted', 'declined'].map((s) => (
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

      {/* Requests List */}
      <div className="space-y-4">
        {loading ? (
          <div className="text-center text-slate-400 py-8">Loading...</div>
        ) : filteredRequests.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <svg className="w-12 h-12 text-slate-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <p className="text-slate-500">No trial requests found</p>
          </div>
        ) : (
          filteredRequests.map((request) => (
            <div key={request.id} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {/* Header */}
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold text-lg text-slate-900">{getName(request)}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[request.status]}`}>
                      {request.status}
                    </span>
                  </div>

                  {/* Details */}
                  <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-slate-600">
                    <p className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                      {getEmail(request)}
                    </p>
                    <p className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                      {getContact(request)}
                    </p>
                    {getStudents(request) && (
                      <p className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                        ~{getStudents(request)} students
                      </p>
                    )}
                    {(request.schoolDomain || request.domain) && (
                      <p className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" /></svg>
                        {request.schoolDomain || request.domain}
                      </p>
                    )}
                  </div>

                  {/* Message */}
                  {request.message && (
                    <div className="mt-2 p-2 bg-slate-50 rounded text-sm text-slate-600 italic">
                      "{request.message}"
                    </div>
                  )}

                  {/* Notes */}
                  <div className="mt-3">
                    {editingNotes === request.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={notesValue}
                          onChange={(e) => setNotesValue(e.target.value)}
                          className="flex-1 px-3 py-1.5 border border-slate-300 rounded text-sm"
                          placeholder="Internal notes..."
                        />
                        <button onClick={() => handleSaveNotes(request.id)} className="text-green-600 hover:text-green-700">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        </button>
                        <button onClick={() => setEditingNotes(null)} className="text-slate-400 hover:text-slate-600">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingNotes(request.id); setNotesValue(request.notes || ''); }}
                        className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        {request.notes || 'Add notes'}
                      </button>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 mt-2">
                    Submitted {new Date(request.createdAt || request.created_at).toLocaleDateString()}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 ml-4">
                  {(request.status === 'pending' || request.status === 'contacted') && (
                    <button onClick={() => handleConvert(request)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                      Convert
                    </button>
                  )}
                  {request.status === 'pending' && (
                    <button onClick={() => handleUpdateStatus(request.id, 'contacted')}
                      className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">
                      Contacted
                    </button>
                  )}
                  {(request.status === 'pending' || request.status === 'contacted') && (
                    <button onClick={() => handleUpdateStatus(request.id, 'declined')}
                      className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-red-600 hover:bg-red-50">
                      Decline
                    </button>
                  )}
                  <button onClick={() => handleDelete(request.id)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-400 hover:text-red-600">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
