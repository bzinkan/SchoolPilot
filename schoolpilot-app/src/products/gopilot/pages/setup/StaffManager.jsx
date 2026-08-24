import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Check, X, Pencil, Eye, EyeOff, RefreshCw, ChevronRight, ArrowLeft } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { GoogleLogo } from './constants';
import GoogleRosterConnectorPanel from '../../../../shared/components/GoogleRosterConnectorPanel';
import StaffAccessTransitionDialog from '../../../../shared/components/StaffAccessTransitionDialog';

// ─── STAFF MANAGER TAB ──────────────────────────────────────────────

function needsGoogleRosterConnector(err) {
  const serverMsg = err?.response?.data?.code || err?.response?.data?.error || '';
  return (
    String(serverMsg).includes('GOOGLE_CONNECTOR_REQUIRED') ||
    String(serverMsg).includes('NO_TOKENS') ||
    String(serverMsg).includes('Google not connected')
  );
}

function workspaceImportIssueText(issue) {
  if (typeof issue === 'string') return issue;
  if (!issue || typeof issue !== 'object') return 'Unknown import issue';
  return [issue.email, issue.code, issue.error || issue.message]
    .filter(Boolean)
    .join(' — ') || 'Unknown import issue';
}

export default function StaffManager({
  staff,
  schoolId,
  onAdd,
  onRemove,
  onUpdate,
  onRefresh,
  onEmailCorrected,
  onRoleTransitioned,
}) {
  const [roleFilter, setRoleFilter] = useState('All');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ email: '', firstName: '', lastName: '', role: 'teacher', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addIdentityConflict, setAddIdentityConflict] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [editPassword, setEditPassword] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState(null);
  const [staffNotice, setStaffNotice] = useState(null);
  const [transitionRequest, setTransitionRequest] = useState(null);

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
  const [wsConnectorRequired, setWsConnectorRequired] = useState(false);
  const [wsImportResult, setWsImportResult] = useState(null);

  // Normalize: API returns { id, userId, role, user: { email, firstName, ... } }
  // Flatten user fields to top level for easy access
  const normalized = useMemo(() => staff.map(s => {
    const u = s.user || {};
    return {
      ...s,
      membershipId: s.membershipId || s.id,
      first_name: s.first_name || s.firstName || u.first_name || u.firstName || '',
      last_name: s.last_name || s.lastName || u.last_name || u.lastName || '',
      email: s.email || u.email || '',
      phone: s.phone || u.phone || '',
      gopilotRole: s.gopilotRole || s.gopilot_role || null,
      effectiveRole: s.gopilotRole || s.gopilot_role || s.role,
    };
  }), [staff]);

  const teachers = normalized.filter(s => s.effectiveRole === 'teacher');
  const officeStaff = normalized.filter(s => s.effectiveRole === 'office_staff');

  const filtered = roleFilter === 'All' ? normalized
    : roleFilter === 'teacher' ? teachers
    : officeStaff;

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!addForm.email || !addForm.firstName || !addForm.lastName) return;
    setAdding(true);
    setAddError(null);
    setAddIdentityConflict(null);
    // Office staff in GoPilot = teacher base role + gopilotRole override
    const payload = addForm.role === 'office_staff'
      ? { ...addForm, role: 'teacher', gopilotRole: 'office_staff' }
      : addForm;
    try {
      await onAdd(payload);
      setAddForm({ email: '', firstName: '', lastName: '', role: 'teacher', password: '' });
      setShowAddForm(false);
    } catch (err) {
      const data = err.response?.data || {};
      if (data.code === 'POSSIBLE_DUPLICATE_STAFF' || data.code === 'STAFF_REACTIVATION_REQUIRED') {
        setAddIdentityConflict({ ...data, pendingPayload: payload });
      }
      setAddError(data.error || 'Failed to add staff');
    }
    setAdding(false);
  };

  const confirmDistinctStaff = async () => {
    if (!addIdentityConflict?.pendingPayload) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd({ ...addIdentityConflict.pendingPayload, confirmDistinctPerson: true });
      setAddForm({ email: '', firstName: '', lastName: '', role: 'teacher', password: '' });
      setAddIdentityConflict(null);
      setShowAddForm(false);
    } catch (err) {
      setAddError(err.response?.data?.error || err.message || 'Failed to add staff');
    } finally {
      setAdding(false);
    }
  };

  const reactivateExistingStaff = async (candidateMembershipId) => {
    const membershipId = candidateMembershipId || addIdentityConflict?.membershipId;
    if (!membershipId) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.post(`/schools/${schoolId}/staff/${membershipId}/reactivate`, {});
      setAddIdentityConflict(null);
      setShowAddForm(false);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setAddError(err.response?.data?.error || err.message || 'Failed to reactivate staff');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (s) => {
    setEditingId(`${s.id}-${s.effectiveRole}`);
    setEditData({ firstName: s.first_name, lastName: s.last_name, email: s.email, role: s.effectiveRole });
    setEditPassword('');
    setEditError(null);
    setShowEditPassword(false);
  };

  const editExistingIdentity = (candidate) => {
    const membershipId = candidate.membershipId || candidate.id;
    const existing = normalized.find((staffMember) => staffMember.id === membershipId);
    if (!existing) {
      setAddError('Reactivate this former staff identity before editing its email.');
      return;
    }
    setRoleFilter('All');
    setShowAddForm(false);
    setAddIdentityConflict(null);
    startEdit(existing);
  };

  const cancelEdit = () => { setEditingId(null); setEditData({}); setEditPassword(''); setEditError(null); };

  const updateStaffEmail = async (s, requestedEmail) => {
    const emailResponse = await api.patch(`/schools/${schoolId}/staff/${s.id}/email`, {
      expectedEmail: s.email,
      email: requestedEmail,
    });
    const confirmedEmail = String(emailResponse.data?.email || emailResponse.data?.user?.email || '').trim().toLowerCase();
    if (!confirmedEmail || confirmedEmail !== requestedEmail) {
      throw new Error('The server did not confirm the requested email address. Refresh before trying again.');
    }
    onEmailCorrected?.(s.id, confirmedEmail, emailResponse.data);
  };

  const saveEdit = async (s) => {
    const selectedRole = editData.role;
    const requestedEmail = String(editData.email || '').trim().toLowerCase();
    const emailChanged = requestedEmail !== String(s.email || '').trim().toLowerCase();
    const roleChanged = selectedRole !== s.effectiveRole;
    const profileChanged = String(editData.firstName || '').trim() !== String(s.first_name || '').trim()
      || String(editData.lastName || '').trim() !== String(s.last_name || '').trim()
      || Boolean(editPassword);
    const changeKinds = [emailChanged, roleChanged, profileChanged].filter(Boolean).length;

    setEditError(null);
    if (changeKinds > 1) {
      setEditError('Save email, role, and profile changes separately so each operation has an unambiguous result.');
      return;
    }
    if (changeKinds === 0) {
      cancelEdit();
      return;
    }

    if (emailChanged) {
      setSaving(true);
      try {
        await updateStaffEmail(s, requestedEmail);
        setStaffNotice(`Email corrected for ${requestedEmail}. The staff member must sign in again.`);
        cancelEdit();
      } catch (err) {
        setEditError(err.response?.data?.error || err.message || 'Failed to correct the email');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (roleChanged && selectedRole === 'office_staff') {
      setTransitionRequest({
        staff: s,
        action: 'change_role',
        newGopilotRole: 'office_staff',
      });
      return;
    }
    if (roleChanged && selectedRole === 'admin' && s.effectiveRole === 'teacher') {
      setTransitionRequest({
        staff: s,
        action: 'change_role',
        newRole: 'admin',
        newGopilotRole: null,
      });
      return;
    }

    setSaving(true);
    try {
      const payload = profileChanged ? {
        firstName: editData.firstName,
        lastName: editData.lastName,
        password: editPassword || undefined,
      } : {};
      if (roleChanged && selectedRole === 'teacher') {
        payload.gopilotRole = s.role === 'teacher' ? null : 'teacher';
      } else if (roleChanged && selectedRole === 'admin') {
        payload.role = 'admin';
        payload.gopilotRole = null;
      }
      await onUpdate(s.id, payload);
      setEditingId(null);
      setEditData({});
      setEditPassword('');
    } catch (err) {
      setEditError(err.response?.data?.error || err.message || 'Failed to update');
    }
    setSaving(false);
  };

  const removeStaffAccess = (s) => {
    setTransitionRequest({ staff: s, action: 'deactivate' });
  };

  const handleTransitionComplete = async (result) => {
    const request = transitionRequest;
    if (!request) return;
    try {
      if (request.action === 'deactivate') {
        await onRemove(request.staff.id, { transitionComplete: true });
      } else {
        onRoleTransitioned?.(request.staff.id, {
          ...(request.newRole !== undefined ? { role: request.newRole } : {}),
          ...(request.newGopilotRole !== undefined ? { gopilotRole: request.newGopilotRole } : {}),
        }, result);
        setEditingId(null);
        setEditData({});
        setEditPassword('');
      }
    } catch (err) {
      const fallback = request.action === 'change_role'
        ? 'The role changed, but the local staff list could not be updated.'
        : 'School access was removed, but the local staff list could not be updated.';
      alert(err.response?.data?.error || err.message || fallback);
      try {
        await onRefresh?.();
      } catch {
        // The transition is already committed; a later setup refresh will reconcile the list.
      }
    }
    setTransitionRequest(null);
  };

  const openWorkspaceImport = async () => {
    setShowWorkspaceModal(true);
    setWsStep('orgunits');
    setWsImportResult(null);
    setWsConnectorRequired(false);
    setWsLoading(true);
    try {
      const res = await api.get(`/schools/${schoolId}/google/org-units`);
      setWsOrgUnits(res.data?.orgUnits || res.data || []);
    } catch (err) {
      if (needsGoogleRosterConnector(err)) {
        setWsConnectorRequired(true);
      } else {
        console.error(err);
      }
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
      const users = res.data?.users || res.data || [];
      const active = users.filter(u => !u.suspended);
      setWsUsers(active);
      setWsSelectedUsers(new Set(active.map(u => u.id).filter(Boolean)));
    } catch (err) {
      console.error(err);
      if (needsGoogleRosterConnector(err)) setWsConnectorRequired(true);
      setWsUsers([]);
    }
    setWsLoading(false);
  };

  const handleWorkspaceImport = async () => {
    setWsImporting(true);
    try {
      const userIds = wsUsers
        .filter(u => wsSelectedUsers.has(u.id))
        .map(u => u.id)
        .filter(Boolean);
      const res = await api.post(`/schools/${schoolId}/google/import-staff`, {
        orgUnitPath: wsSelectedOU?.orgUnitPath || '/',
        userIds,
        role: wsRole,
        source: 'gopilot_setup',
      });
      setWsImportResult(res.data);
      setWsUsers([]);
      setWsSelectedUsers(new Set());
      try {
        await onRefresh?.();
      } catch (refreshError) {
        console.error('Staff import completed, but refreshing the staff list failed:', refreshError);
      }
    } catch (err) {
      console.error(err);
      if (needsGoogleRosterConnector(err)) {
        setWsConnectorRequired(true);
      } else {
        alert('Failed to import staff. Verify the Google Workspace Roster Connector and try again.');
      }
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

      {staffNotice ? (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/30 dark:text-green-100" role="status">
          <span>{staffNotice}</span>
          <button type="button" onClick={() => setStaffNotice(null)} aria-label="Dismiss staff update message">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Action Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
        >
          <Plus className="w-4 h-4" />
          Add Staff
        </button>
        <button
          onClick={openWorkspaceImport}
          className="flex items-center gap-2 px-4 py-2 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 rounded-lg text-sm font-medium text-green-700 dark:text-green-400 hover:bg-green-100"
        >
          <GoogleLogo className="w-4 h-4" />
          Import from Google Workspace
        </button>
      </div>

      {/* Add Staff Form */}
      {showAddForm && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4">
          <h3 className="font-semibold mb-3 dark:text-white">Add Staff Member</h3>
          {addError && <p className="text-red-600 text-sm mb-2">{addError}</p>}
          {addIdentityConflict && (
            <div className="mb-3 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="font-semibold">
                {addIdentityConflict.code === 'STAFF_REACTIVATION_REQUIRED'
                  ? 'Use the existing former-staff identity'
                  : 'A staff member with this name already exists'}
              </p>
              <p>
                Correct the existing identity when this is the same person. Create another account only when these are truly different people.
              </p>
              {(addIdentityConflict.candidates || []).map(candidate => {
                const candidateName = candidate.user?.displayName
                  || [candidate.user?.firstName, candidate.user?.lastName].filter(Boolean).join(' ')
                  || candidate.user?.email
                  || 'Staff member';
                return (
                  <div key={candidate.membershipId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white/70 p-2 dark:border-amber-900 dark:bg-slate-900/70">
                    <span>
                      {candidateName} — {candidate.user?.email}
                      <span className="mt-1 block font-mono text-[10px]">Membership ID: {candidate.membershipId}</span>
                    </span>
                    {candidate.status === 'inactive' ? (
                      <button type="button" onClick={() => reactivateExistingStaff(candidate.membershipId)} disabled={adding} className="rounded bg-green-600 px-2 py-1 font-medium text-white hover:bg-green-700 disabled:opacity-50">
                        Reactivate
                      </button>
                    ) : (
                      <button type="button" onClick={() => editExistingIdentity(candidate)} className="rounded border border-amber-500 px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40">
                        Edit existing email
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2">
                {addIdentityConflict.code === 'STAFF_REACTIVATION_REQUIRED' ? (
                  <button type="button" onClick={() => reactivateExistingStaff()} disabled={adding} className="rounded bg-green-600 px-3 py-1.5 font-medium text-white hover:bg-green-700 disabled:opacity-50">
                    Reactivate existing staff
                  </button>
                ) : (
                  <button type="button" onClick={confirmDistinctStaff} disabled={adding} className="rounded bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800 disabled:opacity-50">
                    This is a different person
                  </button>
                )}
                <button type="button" onClick={() => setAddIdentityConflict(null)} className="rounded border px-3 py-1.5 font-medium hover:bg-white/70 dark:hover:bg-slate-800">
                  Cancel review
                </button>
              </div>
            </div>
          )}
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
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="bg-gray-50 dark:bg-slate-800 text-left text-gray-600 dark:text-slate-300 text-xs uppercase">
              <th className="p-3">Name</th>
              <th className="p-3">Email</th>
              <th className="p-3">Role</th>
              <th className="p-3">Homeroom</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-slate-700">
            {filtered.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-gray-400 dark:text-slate-500">No staff added yet. Click "Add Staff" to get started.</td></tr>
            ) : filtered.map(s => {
              const staffName = s.first_name && s.last_name ? `${s.first_name} ${s.last_name}` : s.email || 'staff member';
              const isEditing = editingId === `${s.id}-${s.effectiveRole}`;
              return isEditing ? (
              <tr key={`${s.id}-${s.effectiveRole}`} className="bg-blue-50 dark:bg-blue-900/30">
                <td className="p-3">
                  <div className="flex gap-1">
                    <input type="text" value={editData.firstName} onChange={e => setEditData(d => ({ ...d, firstName: e.target.value }))}
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-24 dark:bg-slate-800 dark:text-white" placeholder="First" />
                    <input type="text" value={editData.lastName} onChange={e => setEditData(d => ({ ...d, lastName: e.target.value }))}
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-24 dark:bg-slate-800 dark:text-white" placeholder="Last" />
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-gray-500 dark:text-slate-400">Membership ID: {s.membershipId}</p>
                </td>
                <td className="p-3">
                  <input
                    type="email"
                    value={editData.email || ''}
                    onChange={e => setEditData(d => ({ ...d, email: e.target.value }))}
                    className="w-full min-w-48 rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                    aria-label={`Email for ${staffName}`}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">Correct the email here; do not recreate the staff account.</p>
                </td>
                <td className="p-3">
                  <select value={editData.role} onChange={e => setEditData(d => ({ ...d, role: e.target.value }))}
                    className="border dark:border-slate-600 rounded px-2 py-1 text-sm dark:bg-slate-800 dark:text-white">
                    <option value="teacher">Teacher</option>
                    <option value="office_staff">Office Staff</option>
                  </select>
                </td>
                <td className="p-3">
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
                  {editError ? (
                    <p className="mb-2 max-w-64 text-left text-xs text-red-700 dark:text-red-300" role="alert" data-testid="staff-edit-error">
                      {editError}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => saveEdit(s)} disabled={saving}
                      className="px-3 py-1 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={cancelEdit} className="px-3 py-1 border dark:border-slate-600 rounded text-xs font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700">
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
              ) : (
              <tr key={`${s.id}-${s.effectiveRole}`} className="hover:bg-gray-50 dark:hover:bg-slate-800">
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                      {(s.first_name || s.email?.[0] || '?')[0]}{(s.last_name || '')[0] || ''}
                    </div>
                    <div>
                      <span className="font-medium dark:text-white">{s.first_name && s.last_name ? `${s.first_name} ${s.last_name}` : s.email || '—'}</span>
                      <p className="mt-1 font-mono text-[10px] text-gray-500 dark:text-slate-400" data-testid={`staff-membership-id-${s.membershipId}`}>
                        Membership ID: {s.membershipId}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="p-3 text-gray-500 dark:text-slate-400">{s.email}</td>
                <td className="p-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    s.effectiveRole === 'admin' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : s.effectiveRole === 'teacher' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                    : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                  }`}>
                    {s.effectiveRole === 'admin' ? 'Admin' : s.effectiveRole === 'teacher' ? 'Teacher' : 'Office Staff'}
                  </span>
                </td>
                <td className="p-3 text-gray-500 dark:text-slate-400">
                  {s.homeroom_name ? `${s.homeroom_name} (Gr ${s.homeroom_grade})` : '—'}
                </td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button type="button" onClick={() => startEdit(s)} aria-label={`Edit ${staffName}`} className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-500 dark:hover:bg-blue-950/40">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => removeStaffAccess(s)} aria-label={`Remove school access for ${staffName} — ${s.email}`} title="Remove school access" className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-slate-500 dark:hover:bg-red-950/40">
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

      <StaffAccessTransitionDialog
        open={Boolean(transitionRequest)}
        onOpenChange={(open) => {
          if (!open) setTransitionRequest(null);
        }}
        staff={transitionRequest?.staff}
        allStaff={normalized}
        apiBasePath={`/schools/${schoolId}/staff`}
        transitionAction={transitionRequest?.action || 'deactivate'}
        newRole={transitionRequest?.newRole}
        newGopilotRole={transitionRequest?.newGopilotRole}
        onTransitionComplete={handleTransitionComplete}
      />

      {/* Workspace Import Modal for Staff */}
      {showWorkspaceModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
              <div className="flex items-center gap-2">
                <GoogleLogo className="w-5 h-5" />
                <h3 className="font-semibold text-lg dark:text-white">Import Staff from Google Workspace</h3>
              </div>
              <button onClick={() => { setShowWorkspaceModal(false); setWsUsers([]); setWsOrgUnits([]); setWsSelectedUsers(new Set()); setWsConnectorRequired(false); setWsImportResult(null); }}
                className="p-1 hover:bg-gray-100 dark:hover:bg-slate-800 rounded dark:text-slate-300"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {wsImportResult ? (
                <div className="space-y-4" data-testid="gopilot-workspace-staff-import-result">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-gray-500 dark:text-slate-400">Imported</p>
                      <p className="text-2xl font-bold text-green-700 dark:text-green-400">{wsImportResult.imported || 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-gray-500 dark:text-slate-400">Updated</p>
                      <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">{wsImportResult.updated || 0}</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-gray-500 dark:text-slate-400">Skipped / review</p>
                      <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">{wsImportResult.skipped || 0}</p>
                    </div>
                  </div>
                  {wsImportResult.errors?.length > 0 ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
                      <p className="mb-2 font-semibold">Rows requiring review ({wsImportResult.errors.length})</p>
                      <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5" data-testid="gopilot-workspace-staff-import-errors">
                        {wsImportResult.errors.map((issue, index) => (
                          <li key={`${index}-${workspaceImportIssueText(issue)}`}>{workspaceImportIssueText(issue)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    Keep this result open until every skipped or failed row has been reviewed. No row is silently overwritten.
                  </p>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => { setShowWorkspaceModal(false); setWsImportResult(null); }}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : wsConnectorRequired ? (
                <GoogleRosterConnectorPanel
                  basePath={`/schools/${schoolId}/google/roster-connector`}
                  onConnected={openWorkspaceImport}
                />
              ) : wsLoading ? (
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
                        if (e.target.checked) setWsSelectedUsers(new Set(wsUsers.map(u => u.id).filter(Boolean)));
                        else setWsSelectedUsers(new Set());
                      }}
                    />
                    <span className="text-xs text-gray-500 dark:text-slate-400 font-medium">Select all</span>
                  </div>
                  <div className="border dark:border-slate-700 rounded-lg divide-y dark:divide-slate-700 max-h-[40vh] overflow-auto">
                    {wsUsers.map(u => (
                      <label key={u.id || u.email} className="flex items-center gap-3 p-2.5 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer">
                        <input type="checkbox"
                          checked={wsSelectedUsers.has(u.id)}
                          onChange={e => {
                            const next = new Set(wsSelectedUsers);
                            if (e.target.checked) next.add(u.id); else next.delete(u.id);
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

            {!wsImportResult && !wsConnectorRequired && wsStep === 'users' && wsUsers.length > 0 && (
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
