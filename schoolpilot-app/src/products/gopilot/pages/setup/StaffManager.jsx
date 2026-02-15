import React, { useState } from 'react';
import { Plus, Trash2, Check, X, Pencil, Eye, EyeOff, RefreshCw, ChevronRight, ArrowLeft } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { GoogleLogo } from './constants';

// ─── STAFF MANAGER TAB ──────────────────────────────────────────────

export default function StaffManager({ staff, schoolId, googleConnected, onAdd, onRemove, onUpdate, onRefresh }) {
  const [roleFilter, setRoleFilter] = useState('All');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ email: '', firstName: '', lastName: '', role: 'teacher', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [editPassword, setEditPassword] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  // Workspace import state
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [wsOrgUnits, setWsOrgUnits] = useState([]);
  const [wsUsers, setWsUsers] = useState([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsSelectedOU, setWsSelectedOU] = useState(null);
  const [wsSelectedUsers, setWsSelectedUsers] = useState(new Set());
  const [wsImporting, setWsImporting] = useState(false);
  const [wsStep, setWsStep] = useState('orgunits');
  const [wsRole, setWsRole] = useState('teacher');

  // Normalize: API returns { id, userId, role, user: { email, firstName, ... } }
  // Flatten user fields to top level for easy access
  const normalized = staff.map(s => {
    const u = s.user || {};
    return {
      ...s,
      first_name: s.first_name || s.firstName || u.first_name || u.firstName || '',
      last_name: s.last_name || s.lastName || u.last_name || u.lastName || '',
      email: s.email || u.email || '',
      phone: s.phone || u.phone || '',
    };
  });

  const teachers = normalized.filter(s => s.role === 'teacher');
  const officeStaff = normalized.filter(s => s.role === 'office_staff');

  const filtered = roleFilter === 'All' ? normalized
    : roleFilter === 'teacher' ? teachers
    : officeStaff;

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!addForm.email || !addForm.firstName || !addForm.lastName) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(addForm);
      setAddForm({ email: '', firstName: '', lastName: '', role: 'teacher', password: '' });
      setShowAddForm(false);
    } catch (err) {
      setAddError(err.response?.data?.error || 'Failed to add staff');
    }
    setAdding(false);
  };

  const startEdit = (s) => {
    setEditingId(`${s.id}-${s.role}`);
    setEditData({ firstName: s.first_name, lastName: s.last_name, role: s.role });
    setEditPassword('');
    setShowEditPassword(false);
  };

  const cancelEdit = () => { setEditingId(null); setEditData({}); setEditPassword(''); };

  const saveEdit = async (s) => {
    setSaving(true);
    try {
      await onUpdate(s.id, { ...editData, password: editPassword || undefined });
      setEditingId(null);
      setEditData({});
      setEditPassword('');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update');
    }
    setSaving(false);
  };

  const openWorkspaceImport = async () => {
    setShowWorkspaceModal(true);
    setWsStep('orgunits');
    setWsLoading(true);
    try {
      const res = await api.get(`/schools/${schoolId}/google/org-units`);
      setWsOrgUnits(res.data);
    } catch (err) {
      console.error(err);
      setWsOrgUnits([]);
    }
    setWsLoading(false);
  };

  const handleDrillIn = async (ou) => {
    setWsSelectedOU(ou);
    setWsStep('users');
    setWsLoading(true);
    try {
      const path = ou ? ou.orgUnitPath : '/';
      const res = await api.get(`/schools/${schoolId}/google/workspace-users`, { params: { orgUnitPath: path } });
      const active = res.data.filter(u => !u.suspended);
      setWsUsers(active);
      setWsSelectedUsers(new Set(active.map(u => u.email)));
    } catch (err) { console.error(err); setWsUsers([]); }
    setWsLoading(false);
  };

  const handleWorkspaceImport = async () => {
    setWsImporting(true);
    try {
      const usersToImport = wsUsers
        .filter(u => wsSelectedUsers.has(u.email))
        .map(u => ({ email: u.email, firstName: u.firstName, lastName: u.lastName }));
      const res = await api.post(`/schools/${schoolId}/google/import-staff`, { users: usersToImport, role: wsRole });
      alert(`Imported ${res.data.imported} new, updated ${res.data.updated} existing.`);
      setShowWorkspaceModal(false);
      setWsUsers([]);
      setWsSelectedUsers(new Set());
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error(err);
      alert('Failed to import staff.');
    }
    setWsImporting(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Staff Management</h2>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Add teachers and office staff. They can log in with Google or email/password.</p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
        >
          <Plus className="w-4 h-4" />
          Add Staff
        </button>
        {googleConnected ? (
          <button
            onClick={openWorkspaceImport}
            className="flex items-center gap-2 px-4 py-2 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 rounded-lg text-sm font-medium text-green-700 dark:text-green-400 hover:bg-green-100"
          >
            <GoogleLogo className="w-4 h-4" />
            Import from Google Workspace
          </button>
        ) : (
          <button
            onClick={async () => {
              try {
                const res = await api.get(`/schools/${schoolId}/google/auth-url`);
                window.location.href = res.data.url;
              } catch (err) { console.error(err); }
            }}
            className="flex items-center gap-2 px-4 py-2 border dark:border-slate-700 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-200"
          >
            <GoogleLogo className="w-4 h-4" />
            Connect Google
          </button>
        )}
      </div>

      {/* Add Staff Form */}
      {showAddForm && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4">
          <h3 className="font-semibold mb-3 dark:text-white">Add Staff Member</h3>
          {addError && <p className="text-red-600 text-sm mb-2">{addError}</p>}
          <form onSubmit={handleAdd} className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <input
                type="email" placeholder="Email *" required
                value={addForm.email} onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white"
              />
              <input
                type="text" placeholder="First Name *" required
                value={addForm.firstName} onChange={e => setAddForm(f => ({ ...f, firstName: e.target.value }))}
                className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white"
              />
              <input
                type="text" placeholder="Last Name *" required
                value={addForm.lastName} onChange={e => setAddForm(f => ({ ...f, lastName: e.target.value }))}
                className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white"
              />
              <select
                value={addForm.role} onChange={e => setAddForm(f => ({ ...f, role: e.target.value }))}
                className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white"
              >
                <option value="teacher">Teacher</option>
                <option value="office_staff">Office Staff</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password (optional — for email login)"
                  value={addForm.password} onChange={e => setAddForm(f => ({ ...f, password: e.target.value }))}
                  className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm w-full pr-10 dark:bg-slate-800 dark:text-white"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-slate-400">Leave blank if teacher will use Google sign-in</p>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={adding}
                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                {adding ? 'Adding...' : 'Add'}
              </button>
              <button type="button" onClick={() => setShowAddForm(false)}
                className="px-4 py-2 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-200">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Role Filter Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-slate-700 rounded-lg p-1 w-fit">
        {[['All', normalized.length], ['teacher', teachers.length], ['office_staff', officeStaff.length]].map(([r, count]) => (
          <button
            key={r}
            onClick={() => setRoleFilter(r)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${roleFilter === r ? 'bg-white dark:bg-slate-800 shadow dark:shadow-slate-600 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'}`}
          >
            {r === 'All' ? 'All' : r === 'teacher' ? 'Teachers' : 'Office Staff'} ({count})
          </button>
        ))}
      </div>

      {/* Staff Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-slate-800 text-left text-gray-600 dark:text-slate-300 text-xs uppercase">
              <th className="p-3">Name</th>
              <th className="p-3">Email</th>
              <th className="p-3">Role</th>
              <th className="p-3">Homeroom</th>
              <th className="p-3">Login</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-slate-700">
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="p-8 text-center text-gray-400 dark:text-slate-500">No staff added yet. Click "Add Staff" to get started.</td></tr>
            ) : filtered.map(s => {
              const isEditing = editingId === `${s.id}-${s.role}`;
              return isEditing ? (
              <tr key={`${s.id}-${s.role}`} className="bg-blue-50 dark:bg-blue-900/30">
                <td className="p-3">
                  <div className="flex gap-1">
                    <input type="text" value={editData.firstName} onChange={e => setEditData(d => ({ ...d, firstName: e.target.value }))}
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-24 dark:bg-slate-800 dark:text-white" placeholder="First" />
                    <input type="text" value={editData.lastName} onChange={e => setEditData(d => ({ ...d, lastName: e.target.value }))}
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-24 dark:bg-slate-800 dark:text-white" placeholder="Last" />
                  </div>
                </td>
                <td className="p-3 text-gray-500 dark:text-slate-400 text-sm">{s.email}</td>
                <td className="p-3">
                  <select value={editData.role} onChange={e => setEditData(d => ({ ...d, role: e.target.value }))}
                    className="border dark:border-slate-600 rounded px-2 py-1 text-sm dark:bg-slate-800 dark:text-white">
                    <option value="teacher">Teacher</option>
                    <option value="office_staff">Office Staff</option>
                  </select>
                </td>
                <td className="p-3" colSpan={2}>
                  <div className="relative">
                    <input type={showEditPassword ? 'text' : 'password'} value={editPassword}
                      onChange={e => setEditPassword(e.target.value)}
                      placeholder="New password (optional)"
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-full pr-8 dark:bg-slate-800 dark:text-white" />
                    <button type="button" onClick={() => setShowEditPassword(!showEditPassword)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
                      {showEditPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => saveEdit(s)} disabled={saving}
                      className="text-green-600 hover:text-green-800 disabled:opacity-50">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={cancelEdit} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
              ) : (
              <tr key={`${s.id}-${s.role}`} className="hover:bg-gray-50 dark:hover:bg-slate-800">
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                      {(s.first_name || s.email?.[0] || '?')[0]}{(s.last_name || '')[0] || ''}
                    </div>
                    <span className="font-medium dark:text-white">{s.first_name && s.last_name ? `${s.first_name} ${s.last_name}` : s.email || '—'}</span>
                  </div>
                </td>
                <td className="p-3 text-gray-500 dark:text-slate-400">{s.email}</td>
                <td className="p-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    s.role === 'admin' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : s.role === 'teacher' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                    : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                  }`}>
                    {s.role === 'admin' ? 'Admin' : s.role === 'teacher' ? 'Teacher' : 'Office Staff'}
                  </span>
                </td>
                <td className="p-3 text-gray-500 dark:text-slate-400">
                  {s.homeroom_name ? `${s.homeroom_name} (Gr ${s.homeroom_grade})` : '—'}
                </td>
                <td className="p-3">
                  <span className="text-xs text-gray-400 dark:text-slate-500">Google / Password</span>
                </td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => startEdit(s)} className="text-gray-400 dark:text-slate-500 hover:text-blue-600">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => onRemove(s.id)} className="text-gray-400 dark:text-slate-500 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Workspace Import Modal for Staff */}
      {showWorkspaceModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
              <div className="flex items-center gap-2">
                <GoogleLogo className="w-5 h-5" />
                <h3 className="font-semibold text-lg dark:text-white">Import Staff from Google Workspace</h3>
              </div>
              <button onClick={() => { setShowWorkspaceModal(false); setWsUsers([]); setWsOrgUnits([]); setWsSelectedUsers(new Set()); }}
                className="p-1 hover:bg-gray-100 dark:hover:bg-slate-800 rounded dark:text-slate-300"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {wsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <RefreshCw className="w-6 h-6 animate-spin text-gray-400 dark:text-slate-500" />
                  <span className="ml-2 text-gray-500 dark:text-slate-400">Loading...</span>
                </div>
              ) : wsStep === 'orgunits' ? (
                <div>
                  <p className="text-sm text-gray-600 dark:text-slate-300 mb-3">Select an org unit to import staff from.</p>
                  <div className="border dark:border-slate-700 rounded-lg divide-y dark:divide-slate-700">
                    {wsOrgUnits.map(ou => (
                      <button
                        key={ou.orgUnitPath}
                        onClick={() => handleDrillIn(ou)}
                        className="w-full text-left p-3 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-between"
                      >
                        <div>
                          <span className="text-sm font-medium dark:text-white">{ou.name}</span>
                          <p className="text-xs text-gray-500 dark:text-slate-400">{ou.orgUnitPath}</p>
                        </div>
                        <ChevronRight className="w-4 h-4 text-gray-400 dark:text-slate-500" />
                      </button>
                    ))}
                    <button
                      onClick={() => handleDrillIn(null)}
                      className="w-full text-left p-3 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-between"
                    >
                      <div>
                        <span className="text-sm font-medium dark:text-white">/ (All Users)</span>
                        <p className="text-xs text-gray-500 dark:text-slate-400">Browse all domain users</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400 dark:text-slate-500" />
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <button onClick={() => { setWsStep('orgunits'); setWsUsers([]); setWsSelectedUsers(new Set()); }}
                    className="flex items-center gap-1 text-sm text-blue-600 hover:underline mb-3">
                    <ArrowLeft className="w-4 h-4" /> Back to org units
                  </button>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm text-gray-600 dark:text-slate-300">
                      {wsSelectedOU ? `Users in ${wsSelectedOU.name}` : 'All domain users'} — {wsUsers.length} found, {wsSelectedUsers.size} selected
                    </p>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-slate-300">Import as:</label>
                      <select value={wsRole} onChange={e => setWsRole(e.target.value)} className="border dark:border-slate-600 rounded px-2 py-1 text-sm dark:bg-slate-800 dark:text-white">
                        <option value="teacher">Teacher</option>
                        <option value="office_staff">Office Staff</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-2 px-3">
                    <input type="checkbox"
                      checked={wsSelectedUsers.size === wsUsers.length && wsUsers.length > 0}
                      onChange={e => {
                        if (e.target.checked) setWsSelectedUsers(new Set(wsUsers.map(u => u.email)));
                        else setWsSelectedUsers(new Set());
                      }}
                    />
                    <span className="text-xs text-gray-500 dark:text-slate-400 font-medium">Select all</span>
                  </div>
                  <div className="border dark:border-slate-700 rounded-lg divide-y dark:divide-slate-700 max-h-[40vh] overflow-auto">
                    {wsUsers.map(u => (
                      <label key={u.email} className="flex items-center gap-3 p-2.5 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer">
                        <input type="checkbox"
                          checked={wsSelectedUsers.has(u.email)}
                          onChange={e => {
                            const next = new Set(wsSelectedUsers);
                            if (e.target.checked) next.add(u.email); else next.delete(u.email);
                            setWsSelectedUsers(next);
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate dark:text-white">{u.firstName} {u.lastName}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{u.email}</p>
                        </div>
                      </label>
                    ))}
                    {wsUsers.length === 0 && (
                      <p className="text-sm text-gray-500 dark:text-slate-400 py-8 text-center">No users found.</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {wsStep === 'users' && wsUsers.length > 0 && (
              <div className="border-t dark:border-slate-700 p-4 flex items-center justify-between">
                <p className="text-sm text-gray-600 dark:text-slate-300">{wsSelectedUsers.size} selected</p>
                <button
                  disabled={wsSelectedUsers.size === 0 || wsImporting}
                  onClick={handleWorkspaceImport}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {wsImporting ? 'Importing...' : `Import ${wsSelectedUsers.size} as ${wsRole === 'teacher' ? 'Teachers' : 'Office Staff'}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
