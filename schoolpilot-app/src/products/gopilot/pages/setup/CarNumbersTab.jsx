import React, { useState, useCallback, useEffect } from 'react';
import { X, Car, Plus, Trash2, Search, CheckCircle2, ArrowRight, RefreshCw, Download, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../../../shared/utils/api';

// ─── CAR NUMBERS TAB ──────────────────────────────────────────────
export default function CarNumbersTab({ schoolId, students }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [familyNameInput, setFamilyNameInput] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [dismissalMode, setDismissalMode] = useState('no_app');
  const [showAppModeConfirm, setShowAppModeConfirm] = useState(false);
  const [sendingToApp, setSendingToApp] = useState(false);
  const [appModeGroups, setAppModeGroups] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingCarNumber, setEditingCarNumber] = useState('');

  const clientUrl = window.location.origin;

  const loadGroups = useCallback(async () => {
    if (!schoolId) return;
    try {
      const [groupsRes, modeRes] = await Promise.all([
        api.get(`/schools/${schoolId}/family-groups`),
        api.get(`/schools/${schoolId}/dismissal-mode`),
      ]);
      setGroups(groupsRes.data);
      setDismissalMode(modeRes.data.mode);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [schoolId]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  // Students already assigned to a group
  const assignedStudentIds = new Set(groups.flatMap(g => (g.students || []).map(s => s.id)));
  const unassigned = students.filter(s => !assignedStudentIds.has(s.id));
  const filteredUnassigned = unassigned.filter(s => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return `${s.firstName || s.first_name} ${s.lastName || s.last_name}`.toLowerCase().includes(term);
  });

  const toggleStudent = (id) => {
    setSelectedStudents(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedStudents.size === filteredUnassigned.length) {
      setSelectedStudents(new Set());
    } else {
      setSelectedStudents(new Set(filteredUnassigned.map(s => s.id)));
    }
  };

  const handleCreateGroup = async () => {
    if (selectedStudents.size === 0) return;
    setCreating(true);
    try {
      await api.post(`/schools/${schoolId}/family-groups`, {
        familyName: familyNameInput || null,
        studentIds: Array.from(selectedStudents),
      });
      setSelectedStudents(new Set());
      setFamilyNameInput('');
      setShowCreateDialog(false);
      await loadGroups();
    } catch (err) {
      console.error('Failed to create family group:', err?.response?.data || err);
      alert(err?.response?.data?.error || 'Failed to create family group');
    } finally { setCreating(false); }
  };

  const handleAddToGroup = async (groupId) => {
    if (selectedStudents.size === 0) return;
    try {
      await api.post(`/family-groups/${groupId}/students`, { studentIds: Array.from(selectedStudents) });
      setSelectedStudents(new Set());
      await loadGroups();
    } catch { /* ignore */ }
  };

  const handleRemoveStudent = async (groupId, studentId) => {
    try {
      await api.delete(`/family-groups/${groupId}/students/${studentId}`);
      await loadGroups();
    } catch { /* ignore */ }
  };

  const handleDeleteGroup = async (groupId) => {
    try {
      await api.delete(`/family-groups/${groupId}`);
      await loadGroups();
    } catch { /* ignore */ }
  };

  const handleSaveCarNumber = async (groupId) => {
    if (!editingCarNumber.trim()) return;
    try {
      await api.put(`/family-groups/${groupId}`, { carNumber: editingCarNumber.trim() });
      setEditingGroupId(null);
      setEditingCarNumber('');
      await loadGroups();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to update car number');
    }
  };

  const handleAutoAssign = async () => {
    setAutoAssigning(true);
    try {
      await api.post(`/schools/${schoolId}/family-groups/auto-assign`);
      await loadGroups();
    } catch { /* ignore */ }
    finally { setAutoAssigning(false); }
  };

  const handleSendToAppMode = async () => {
    setSendingToApp(true);
    try {
      const res = await api.post(`/schools/${schoolId}/send-to-app-mode`);
      setDismissalMode('app');
      setAppModeGroups(res.data.groups);
      setShowAppModeConfirm(false);
    } catch { /* ignore */ }
    finally { setSendingToApp(false); }
  };

  const handleDownloadCSV = () => {
    const displayGroups = dismissalMode === 'app' ? (appModeGroups || groups) : groups;
    const rows = [['Family Group', 'Students', 'Car Number']];
    displayGroups.forEach(g => {
      const studentNames = (g.students || []).map(s => `${s.first_name} ${s.last_name}`).join('; ');
      rows.push([g.family_name || '', studentNames, g.car_number || '']);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'car-numbers.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="text-center py-12"><p className="text-gray-500">Loading car numbers...</p></div>;

  // App mode view: show QR codes for distribution
  if (dismissalMode === 'app') {
    const displayGroups = appModeGroups || groups;
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold">Car Numbers — App Mode</h2>
            <p className="text-sm text-gray-500">Distribute QR codes to families so they can register and link their children.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!window.confirm('Switch back to manual car number mode? Invite tokens will be preserved.')) return;
                try {
                  await api.post(`/schools/${schoolId}/switch-to-no-app-mode`);
                  setDismissalMode('no_app');
                } catch (err) {
                  alert('Failed to switch mode');
                }
              }}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
            >
              Switch to No-App Mode
            </button>
            <button
              onClick={handleDownloadCSV}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
            >
              Download CSV
            </button>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm"
            >
              <Printer className="w-4 h-4" /> Print All
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayGroups.map(group => {
            const inviteUrl = group.invite_token ? `${clientUrl}/register?invite=${group.invite_token}` : null;
            return (
              <div key={group.id} className="bg-white rounded-xl border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold text-indigo-600">#{group.car_number}</span>
                    {group.family_name && <span className="text-sm text-gray-500">{group.family_name}</span>}
                  </div>
                  {group.claimed_by_user_id ? (
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Claimed</span>
                  ) : (
                    <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full">Unclaimed</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {(group.students || []).map(s => (
                    <span key={s.id} className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                      {s.first_name} {s.last_name}
                    </span>
                  ))}
                </div>
                {inviteUrl && (
                  <div className="flex flex-col items-center border-t pt-3">
                    <QRCodeSVG value={inviteUrl} size={120} />
                    <p className="text-xs text-gray-400 mt-2 break-all text-center">{inviteUrl}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // No-app mode: two-panel grouping UI
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Car Numbers</h2>
        <div className="flex items-center gap-2">
          {groups.length > 0 && (
            <button
              onClick={handleDownloadCSV}
              className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
            >
              Download CSV
            </button>
          )}
          {unassigned.length > 0 && (
            <button
              onClick={handleAutoAssign}
              disabled={autoAssigning}
              className="flex items-center gap-1 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {autoAssigning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Auto-Number Remaining ({unassigned.length})
            </button>
          )}
          <button
            onClick={() => setShowAppModeConfirm(true)}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <ArrowRight className="w-4 h-4" /> Send to App Mode
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Panel: Unassigned Students */}
        <div className="bg-white rounded-xl border">
          <div className="p-4 border-b">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Unassigned Students ({unassigned.length})</h3>
              {filteredUnassigned.length > 0 && (
                <button onClick={selectAll} className="text-sm text-indigo-600 hover:text-indigo-700">
                  {selectedStudents.size === filteredUnassigned.length ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search students..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm"
              />
            </div>
          </div>
          <div className="max-h-[500px] overflow-y-auto divide-y">
            {filteredUnassigned.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-400" />
                <p>{unassigned.length === 0 ? 'All students assigned!' : 'No matches'}</p>
              </div>
            ) : (
              filteredUnassigned.map(s => (
                <label key={s.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedStudents.has(s.id)}
                    onChange={() => toggleStudent(s.id)}
                    className="rounded border-gray-300 text-indigo-600"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.firstName || s.first_name} {s.lastName || s.last_name}</p>
                    <p className="text-xs text-gray-500">Grade {s.grade} {s.homeroom_name ? `· ${s.homeroom_name}` : ''}</p>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${s.dismissalType === 'car' || s.dismissal_type === 'car' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                    {s.dismissalType || s.dismissal_type}
                  </span>
                </label>
              ))
            )}
          </div>
          {selectedStudents.size > 0 && (
            <div className="p-3 border-t bg-gray-50 flex items-center gap-2">
              <span className="text-sm text-gray-600">{selectedStudents.size} selected</span>
              <button
                onClick={() => setShowCreateDialog(true)}
                className="ml-auto px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                Create Group
              </button>
              {groups.length > 0 && (
                <div className="relative group">
                  <button className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-100">
                    Add to Group ▾
                  </button>
                  <div className="absolute right-0 mt-1 w-48 bg-white border rounded-lg shadow-lg z-10 hidden group-hover:block">
                    {groups.map(g => (
                      <button
                        key={g.id}
                        onClick={() => handleAddToGroup(g.id)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        #{g.car_number} {g.family_name || ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Panel: Family Groups */}
        <div className="space-y-3">
          <h3 className="font-semibold">Family Groups ({groups.length})</h3>
          {groups.length === 0 ? (
            <div className="bg-white rounded-xl border p-8 text-center text-gray-500">
              <Car className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p>No groups yet. Select students and create a group.</p>
            </div>
          ) : (
            <div className="max-h-[550px] overflow-y-auto space-y-3">
              {groups.map(g => (
                <div key={g.id} className="bg-white rounded-xl border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {editingGroupId === g.id ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xl font-bold text-indigo-600">#</span>
                          <input
                            type="text"
                            value={editingCarNumber}
                            onChange={e => setEditingCarNumber(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveCarNumber(g.id);
                              if (e.key === 'Escape') { setEditingGroupId(null); setEditingCarNumber(''); }
                            }}
                            onBlur={() => handleSaveCarNumber(g.id)}
                            autoFocus
                            maxLength={5}
                            className="w-16 text-xl font-bold text-indigo-600 border-b-2 border-indigo-400 outline-none bg-transparent"
                          />
                        </div>
                      ) : (
                        <span className="text-xl font-bold text-indigo-600">
                          #{g.car_number}
                        </span>
                      )}
                      {g.family_name && <span className="text-sm text-gray-500">{g.family_name}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setEditingGroupId(g.id); setEditingCarNumber(g.car_number); }} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium px-2 py-1 rounded hover:bg-indigo-50">
                        Edit #
                      </button>
                      <button onClick={() => handleDeleteGroup(g.id)} className="p-1 text-gray-500 hover:text-red-600 rounded hover:bg-red-50">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(g.students || []).map(s => (
                      <span key={s.id} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 pl-2 pr-1 py-1 rounded-full">
                        {s.first_name} {s.last_name}
                        <button
                          onClick={() => handleRemoveStudent(g.id, s.id)}
                          className="text-gray-400 hover:text-red-500 ml-0.5"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    {(!g.students || g.students.length === 0) && (
                      <span className="text-xs text-gray-400 italic">No students</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create Group Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold mb-4">Create Family Group</h3>
            <p className="text-sm text-gray-500 mb-3">{selectedStudents.size} student(s) selected</p>
            <input
              type="text"
              placeholder="Family name (optional)"
              value={familyNameInput}
              onChange={(e) => setFamilyNameInput(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowCreateDialog(false); setFamilyNameInput(''); }}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={creating}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send to App Mode Confirmation */}
      {showAppModeConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-2">Switch to App Mode</h3>
            <p className="text-sm text-gray-600 mb-4">
              This will generate invite QR codes for every family group. Parents can scan these to register and automatically link to their children with the same car number.
            </p>
            <p className="text-sm text-amber-600 mb-4 font-medium">
              {unassigned.length > 0 ? `⚠ ${unassigned.length} student(s) are not in a family group yet. They won't get a QR code.` : 'All students are assigned to groups.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAppModeConfirm(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSendToAppMode}
                disabled={sendingToApp}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {sendingToApp ? 'Switching...' : 'Switch to App Mode'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
