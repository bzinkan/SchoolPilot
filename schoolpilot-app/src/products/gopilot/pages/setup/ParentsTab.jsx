import React, { useState, useEffect } from 'react';
import { Users, Search, Copy, Check, Pencil, Trash2, X, Save, Smartphone, QrCode } from 'lucide-react';
import api from '../../../../shared/utils/api';

export default function ParentsTab({ schoolId }) {
  const [parents, setParents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [schoolSlug, setSchoolSlug] = useState('');
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [checkInMethod, setCheckInMethod] = useState('app');

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    async function fetch() {
      setLoading(true);
      try {
        const [parentsRes, schoolRes, settingsRes] = await Promise.all([
          api.get(`/schools/${schoolId}/parents`),
          api.get(`/schools/${schoolId}`),
          api.get(`/schools/${schoolId}/settings`).catch(() => ({ data: {} })),
        ]);
        if (!cancelled) {
          const raw = Array.isArray(parentsRes.data) ? parentsRes.data : (parentsRes.data?.parents ?? []);
          setParents(normalizeParents(raw));
          setSchoolSlug(schoolRes.data?.slug || schoolRes.data?.school?.slug || '');
          setCheckInMethod(settingsRes.data?.checkInMethod || 'app');
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    }
    fetch();
    return () => { cancelled = true; };
  }, [schoolId]);

  // Normalize API response to a flat shape for the table
  function normalizeParents(raw) {
    return raw.map(p => ({
      membershipId: p.membershipId || p.membership_id || p.id,
      userId: p.userId || p.user_id || p.user?.id,
      firstName: p.user?.firstName || p.first_name || p.firstName || '',
      lastName: p.user?.lastName || p.last_name || p.lastName || '',
      email: p.user?.email || p.email || '',
      phone: p.user?.phone || p.phone || '',
      carNumber: p.carNumber || p.car_number || '',
      children: (p.children || []).map(c => ({
        id: c.id,
        firstName: c.firstName || c.first_name || '',
        lastName: c.lastName || c.last_name || '',
        grade: c.gradeLevel || c.grade_level || c.grade || '',
      })),
    }));
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(schoolSlug);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startEdit = (parent) => {
    setEditingId(parent.membershipId);
    setEditForm({
      firstName: parent.firstName,
      lastName: parent.lastName,
      phone: parent.phone || '',
      carNumber: parent.carNumber || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  const handleSave = async (parent) => {
    setSaving(true);
    try {
      await api.put(`/users/staff/${parent.membershipId}`, {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        carNumber: editForm.carNumber || null,
      });
      // Update local state
      setParents(prev => prev.map(p =>
        p.membershipId === parent.membershipId
          ? { ...p, firstName: editForm.firstName, lastName: editForm.lastName, phone: editForm.phone, carNumber: editForm.carNumber }
          : p
      ));
      setEditingId(null);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update parent');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (parent) => {
    if (!confirm(`Remove ${parent.firstName} ${parent.lastName} from this school? This will unlink them from all children.`)) return;
    setDeleting(parent.membershipId);
    try {
      await api.delete(`/users/staff/${parent.membershipId}`);
      setParents(prev => prev.filter(p => p.membershipId !== parent.membershipId));
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to remove parent');
    } finally {
      setDeleting(null);
    }
  };

  const filtered = parents.filter(p => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return `${p.firstName} ${p.lastName}`.toLowerCase().includes(term)
      || p.email?.toLowerCase().includes(term)
      || p.carNumber?.includes(term);
  });

  if (loading) return <div className="text-center py-12"><p className="text-gray-500 dark:text-slate-400">Loading parents...</p></div>;

  return (
    <div>
      {schoolSlug && (
        <div className="mb-4 p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-medium text-indigo-900 dark:text-indigo-300">Parent Invite Code</p>
              <p className="text-lg font-bold text-indigo-700 dark:text-indigo-400 font-mono">{schoolSlug}</p>
            </div>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              {copied ? <><Check className="w-4 h-4" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy Code</>}
            </button>
          </div>
          <p className="text-xs text-indigo-600 dark:text-indigo-400 mt-2">
            Share this code with parents. They'll enter it when creating their account in the GoPilot app.
          </p>
        </div>
      )}

      <div className="mb-4 p-4 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl">
        <div className="flex items-center gap-3">
          {checkInMethod === 'qr' ? <QrCode className="w-5 h-5 text-gray-600 dark:text-slate-300" /> : <Smartphone className="w-5 h-5 text-gray-600 dark:text-slate-300" />}
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-slate-200">
              Check-In Method: <span className="font-bold text-gray-900 dark:text-white">{checkInMethod === 'qr' ? 'QR Code Tag' : 'GoPilot App'}</span>
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              {checkInMethod === 'qr' ? 'Parents display their QR code tag in the car window.' : 'Parents tap "I\'m Here" in the app when they arrive.'}
              {' '}Change in School Settings.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold dark:text-white">Parents ({parents.length})</h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-slate-500" />
          <input
            type="text"
            placeholder="Search parents or car #..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg text-sm w-64"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-slate-400">
          <Users className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
          <p>{searchTerm ? 'No parents match your search' : 'No parents have joined this school yet'}</p>
          {!searchTerm && (
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-2 max-w-md mx-auto">
              Parents will appear here after they download the GoPilot app, create an account using the invite code above, and link to their children using their car number.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead className="bg-gray-50 dark:bg-slate-800 border-b dark:border-slate-700">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Parent</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Email</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Phone</th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Car #</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Children</th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-500 dark:text-slate-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-slate-700">
              {filtered.map(parent => (
                <tr key={parent.membershipId} className="hover:bg-gray-50 dark:hover:bg-slate-800">
                  <td className="px-4 py-3">
                    {editingId === parent.membershipId ? (
                      <div className="flex gap-1">
                        <input
                          value={editForm.firstName}
                          onChange={(e) => setEditForm(f => ({ ...f, firstName: e.target.value }))}
                          className="w-24 px-2 py-1 border dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded text-sm"
                          placeholder="First"
                        />
                        <input
                          value={editForm.lastName}
                          onChange={(e) => setEditForm(f => ({ ...f, lastName: e.target.value }))}
                          className="w-24 px-2 py-1 border dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded text-sm"
                          placeholder="Last"
                        />
                      </div>
                    ) : (
                      <p className="font-medium dark:text-white">{parent.firstName} {parent.lastName}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-slate-400">{parent.email}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-slate-400">
                    {editingId === parent.membershipId ? (
                      <input
                        value={editForm.phone}
                        onChange={(e) => setEditForm(f => ({ ...f, phone: e.target.value }))}
                        className="w-32 px-2 py-1 border dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded text-sm"
                        placeholder="Phone"
                      />
                    ) : (
                      parent.phone || '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {editingId === parent.membershipId ? (
                      <input
                        value={editForm.carNumber}
                        onChange={(e) => setEditForm(f => ({ ...f, carNumber: e.target.value }))}
                        className="w-16 px-2 py-1 border dark:border-slate-600 dark:bg-slate-700 dark:text-white rounded text-sm text-center"
                        placeholder="#"
                      />
                    ) : parent.carNumber ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-bold bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400">
                        #{parent.carNumber}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {parent.children.length > 0 ? parent.children.map(c =>
                      <span key={c.id} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 mr-1 mb-1">
                        {c.firstName} {c.lastName} (Gr {c.grade})
                      </span>
                    ) : <span className="text-gray-400 dark:text-slate-500">No linked children</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {editingId === parent.membershipId ? (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleSave(parent)}
                          disabled={saving}
                          className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors disabled:opacity-50"
                          title="Save"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => startEdit(parent)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                          title="Edit parent"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(parent)}
                          disabled={deleting === parent.membershipId}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                          title="Remove parent"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
