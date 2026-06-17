import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../../components/ThemeToggle';
import api from '../../shared/utils/api';

const statusColors = {
  pending: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  converted: 'bg-green-100 text-green-800',
  closed: 'bg-slate-100 text-slate-700',
};

const statusCards = [
  { key: 'pending', label: 'Pending', color: 'text-yellow-600', bg: 'bg-yellow-50' },
  { key: 'contacted', label: 'Contacted', color: 'text-blue-600', bg: 'bg-blue-50' },
  { key: 'converted', label: 'Converted', color: 'text-green-600', bg: 'bg-green-50' },
  { key: 'closed', label: 'Closed', color: 'text-slate-600', bg: 'bg-slate-50' },
];

const productLabels = {
  CLASSPILOT: 'ClassPilot',
  PASSPILOT: 'PassPilot',
  GOPILOT: 'GoPilot',
};

function productList(value) {
  return String(value || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export default function Inquiries() {
  const navigate = useNavigate();
  const [inquiries, setInquiries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesValue, setNotesValue] = useState('');

  const loadInquiries = useCallback(async () => {
    try {
      setLoading(true);
      const params = {};
      if (statusFilter !== 'all') params.status = statusFilter;
      const res = await api.get('/super-admin/inquiries', { params });
      setInquiries(Array.isArray(res.data) ? res.data : (res.data?.inquiries ?? []));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadInquiries(); }, [loadInquiries]);

  const filteredInquiries = inquiries.filter((inquiry) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [
      inquiry.schoolName,
      inquiry.domain,
      inquiry.contactName,
      inquiry.contactEmail,
      inquiry.adminItEmail,
      inquiry.billingEmail,
    ].some((v) => String(v || '').toLowerCase().includes(q));
  });

  const statusCounts = Object.fromEntries(
    statusCards.map((s) => [s.key, inquiries.filter((i) => i.status === s.key).length])
  );

  const handleUpdateStatus = async (id, status) => {
    try {
      await api.patch(`/super-admin/inquiries/${id}`, { status });
      loadInquiries();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update');
    }
  };

  const handleSaveNotes = async (id) => {
    try {
      await api.patch(`/super-admin/inquiries/${id}`, { notes: notesValue });
      setEditingNotes(null);
      loadInquiries();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to save notes');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this school inquiry?')) return;
    try {
      await api.delete(`/super-admin/inquiries/${id}`);
      loadInquiries();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleConvert = (inquiry) => {
    const params = new URLSearchParams();
    if (inquiry.schoolName) params.set('name', inquiry.schoolName);
    if (inquiry.domain) params.set('domain', inquiry.domain);
    if (inquiry.adminItEmail || inquiry.contactEmail) params.set('email', inquiry.adminItEmail || inquiry.contactEmail);
    if (inquiry.contactName) params.set('adminName', inquiry.contactName);
    if (inquiry.billingEmail) params.set('billingEmail', inquiry.billingEmail);
    navigate(`/super-admin/schools/new?${params.toString()}`);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/super-admin/schools')}
            className="p-2 hover:bg-slate-100 rounded-lg">
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">School Inquiries</h1>
            <p className="text-sm text-slate-500">Review and manage incoming information requests</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {statusCards.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatusFilter(statusFilter === s.key ? 'all' : s.key)}
            className={`rounded-xl border p-4 text-left transition-all ${
              statusFilter === s.key ? 'ring-2 ring-slate-400 border-slate-400' : 'border-slate-200 hover:border-slate-300'
            } ${s.bg}`}
          >
            <p className={`text-2xl font-bold ${s.color}`}>{statusCounts[s.key] || 0}</p>
            <p className="text-xs text-slate-500">{s.label}</p>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            placeholder="Search by school, email, contact, or domain..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {['all', 'pending', 'contacted', 'converted', 'closed'].map((s) => (
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

      <div className="space-y-4">
        {loading ? (
          <div className="text-center text-slate-400 py-8">Loading...</div>
        ) : filteredInquiries.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <svg className="w-12 h-12 text-slate-300 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <p className="text-slate-500">No school inquiries found</p>
          </div>
        ) : (
          filteredInquiries.map((inquiry) => (
            <div key={inquiry.id} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold text-lg text-slate-900">{inquiry.schoolName || 'Unknown school'}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[inquiry.status] || statusColors.pending}`}>
                      {inquiry.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-slate-600">
                    <p className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                      {inquiry.contactEmail}
                    </p>
                    <p className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                      {inquiry.contactName || 'No contact name'}
                    </p>
                    {inquiry.contactPhone && <p>Phone: {inquiry.contactPhone}</p>}
                    {inquiry.preferredContactMethod && <p>Prefers: {inquiry.preferredContactMethod}</p>}
                    {inquiry.adminItEmail && <p>Admin/IT: {inquiry.adminItEmail}</p>}
                    {inquiry.billingEmail && <p>Billing: {inquiry.billingEmail}</p>}
                    {inquiry.estimatedStudents && <p>Students: ~{inquiry.estimatedStudents}</p>}
                    {inquiry.domain && <p>Domain: {inquiry.domain}</p>}
                  </div>

                  {productList(inquiry.interestedProducts).length > 0 && (
                    <div className="flex gap-2 flex-wrap mt-3">
                      {productList(inquiry.interestedProducts).map((product) => (
                        <span key={product} className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-700">
                          {productLabels[product] || product}
                        </span>
                      ))}
                    </div>
                  )}

                  {inquiry.questions && (
                    <div className="mt-3 p-3 bg-slate-50 rounded text-sm text-slate-600 whitespace-pre-wrap">
                      {inquiry.questions}
                    </div>
                  )}

                  <div className="mt-3">
                    {editingNotes === inquiry.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={notesValue}
                          onChange={(e) => setNotesValue(e.target.value)}
                          className="flex-1 px-3 py-1.5 border border-slate-300 rounded text-sm"
                          placeholder="Internal notes..."
                        />
                        <button onClick={() => handleSaveNotes(inquiry.id)} className="text-green-600 hover:text-green-700">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        </button>
                        <button onClick={() => setEditingNotes(null)} className="text-slate-400 hover:text-slate-600">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingNotes(inquiry.id); setNotesValue(inquiry.notes || ''); }}
                        className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        {inquiry.notes || 'Add notes'}
                      </button>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 mt-2">
                    Submitted {new Date(inquiry.createdAt || inquiry.created_at).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex flex-col gap-2 ml-4">
                  {(inquiry.status === 'pending' || inquiry.status === 'contacted') && (
                    <button onClick={() => handleConvert(inquiry)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                      Create School
                    </button>
                  )}
                  {inquiry.status === 'pending' && (
                    <button onClick={() => handleUpdateStatus(inquiry.id, 'contacted')}
                      className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50">
                      Contacted
                    </button>
                  )}
                  {(inquiry.status === 'pending' || inquiry.status === 'contacted') && (
                    <button onClick={() => handleUpdateStatus(inquiry.id, 'closed')}
                      className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">
                      Close
                    </button>
                  )}
                  <button onClick={() => handleDelete(inquiry.id)}
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
