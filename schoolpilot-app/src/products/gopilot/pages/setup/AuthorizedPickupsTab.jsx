import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Plus, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import api from '../../../../shared/utils/api';

const toArray = (payload, key) => Array.isArray(payload) ? payload : (payload?.[key] || []);

function normalizeStudent(student) {
  return {
    id: student.id,
    firstName: student.firstName || student.first_name || '',
    lastName: student.lastName || student.last_name || '',
    gradeLevel: student.gradeLevel || student.grade_level || student.grade || '',
  };
}

function normalizePickup(pickup) {
  return {
    ...pickup,
    id: pickup.id,
    studentId: pickup.studentId || pickup.student_id,
    status: pickup.status || 'pending',
    relationship: pickup.relationship || '',
    phone: pickup.phone || '',
  };
}

export default function AuthorizedPickupsTab({ schoolId }) {
  const [students, setStudents] = useState([]);
  const [pickups, setPickups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ studentId: '', name: '', relationship: '', phone: '' });

  const load = useCallback(async () => {
    if (!schoolId) return;
    setLoading(true);
    setError('');
    try {
      const [pickupResponse, studentResponse] = await Promise.all([
        api.get('/pickups/all'),
        api.get('/gopilot/students'),
      ]);
      setPickups(toArray(pickupResponse.data, 'pickups').map(normalizePickup));
      setStudents(toArray(studentResponse.data, 'students').map(normalizeStudent));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Authorized pickups could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => {
    load();
  }, [load]);

  const studentsById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
  const visiblePickups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return pickups;
    return pickups.filter((pickup) => {
      const student = studentsById.get(pickup.studentId);
      return [pickup.name, pickup.relationship, pickup.phone, student?.firstName, student?.lastName]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }, [pickups, search, studentsById]);

  const createPickup = async (event) => {
    event.preventDefault();
    if (!form.studentId || !form.name.trim() || !form.relationship.trim()) return;
    setBusyId('create');
    setError('');
    try {
      const response = await api.post(`/pickups/student/${form.studentId}`, {
        name: form.name.trim(),
        relationship: form.relationship.trim(),
        phone: form.phone.trim() || undefined,
      });
      setPickups((current) => [...current, normalizePickup(response.data?.pickup || response.data)]);
      setForm({ studentId: '', name: '', relationship: '', phone: '' });
      setShowAdd(false);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Authorized pickup could not be added.');
    } finally {
      setBusyId(null);
    }
  };

  const updateStatus = async (pickup, status) => {
    setBusyId(pickup.id);
    setError('');
    try {
      const response = await api.put(`/pickups/${pickup.id}`, { status });
      const updated = normalizePickup(response.data?.pickup || { ...pickup, status });
      setPickups((current) => current.map((item) => item.id === pickup.id ? updated : item));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Pickup status could not be updated.');
    } finally {
      setBusyId(null);
    }
  };

  const revokePickup = async (pickup) => {
    const student = studentsById.get(pickup.studentId);
    const studentName = student ? `${student.firstName} ${student.lastName}` : 'this student';
    if (!window.confirm(`Revoke ${pickup.name}'s authorization to pick up ${studentName}? This keeps the historical record.`)) return;
    setBusyId(pickup.id);
    setError('');
    try {
      const response = await api.delete(`/pickups/${pickup.id}`);
      const revoked = normalizePickup(response.data?.pickup || { ...pickup, status: 'revoked' });
      setPickups((current) => current.map((item) => item.id === pickup.id ? revoked : item));
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Pickup authorization could not be revoked.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-labelledby="authorized-pickups-title">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">School managed</p>
          <h2 id="authorized-pickups-title" className="mt-1 text-2xl font-bold tracking-tight text-gray-950 dark:text-white">Authorized pickups</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-slate-400">Office staff approve and revoke pickup contacts. Historical records remain intact.</p>
        </div>
        <button type="button" onClick={() => setShowAdd(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:ring-offset-slate-950">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add pickup
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      )}

      <div className="mb-4 relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        <label htmlFor="pickup-search" className="sr-only">Search authorized pickups</label>
        <input id="pickup-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search contact or student" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white pl-10 pr-3 text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white p-10 text-sm text-gray-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400" role="status">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading authorized pickups…
        </div>
      ) : visiblePickups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <ShieldCheck className="mx-auto h-10 w-10 text-gray-300 dark:text-slate-600" aria-hidden="true" />
          <p className="mt-3 font-semibold text-gray-800 dark:text-slate-200">{search ? 'No matching pickup contacts' : 'No authorized pickups yet'}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Add contacts only after the school has verified their authorization.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full min-w-[720px] text-left">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              <tr><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Student</th><th className="px-4 py-3">Relationship</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {visiblePickups.map((pickup) => {
                const student = studentsById.get(pickup.studentId);
                return (
                  <tr key={pickup.id}>
                    <td className="px-4 py-3"><p className="font-semibold text-gray-950 dark:text-white">{pickup.name}</p><p className="text-xs text-gray-500 dark:text-slate-400">{pickup.phone || 'No phone on file'}</p></td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-slate-300">{student ? `${student.firstName} ${student.lastName}` : 'Student record unavailable'}{student?.gradeLevel ? <span className="ml-2 text-xs text-gray-400">Grade {student.gradeLevel}</span> : null}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-slate-300">{pickup.relationship}</td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${pickup.status === 'approved' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' : pickup.status === 'revoked' ? 'bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'}`}>{pickup.status}</span></td>
                    <td className="px-4 py-3"><div className="flex justify-end gap-2">
                      {pickup.status === 'pending' && <button type="button" disabled={busyId === pickup.id} onClick={() => updateStatus(pickup, 'approved')} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-emerald-300 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"><Check className="h-4 w-4" aria-hidden="true" /> Approve</button>}
                      {pickup.status !== 'revoked' && <button type="button" disabled={busyId === pickup.id} onClick={() => revokePickup(pickup)} className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:text-red-300" aria-label={`Revoke ${pickup.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAdd(false); }}>
          <form onSubmit={createPickup} role="dialog" aria-modal="true" aria-labelledby="add-pickup-title" className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:p-6">
            <div className="mb-5 flex items-center justify-between"><h3 id="add-pickup-title" className="text-xl font-bold text-gray-950 dark:text-white">Add authorized pickup</h3><button type="button" onClick={() => setShowAdd(false)} className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-slate-800" aria-label="Close"><X className="h-5 w-5" aria-hidden="true" /></button></div>
            <p className="mb-5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Verify the contact with school records before approving them.</p>
            <div className="space-y-4">
              <div><label htmlFor="pickup-student" className="mb-1 block text-sm font-semibold dark:text-slate-200">Student</label><select id="pickup-student" required value={form.studentId} onChange={(event) => setForm((current) => ({ ...current, studentId: event.target.value }))} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 dark:border-slate-600 dark:bg-slate-800 dark:text-white"><option value="">Choose a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.lastName}, {student.firstName}{student.gradeLevel ? ` — Grade ${student.gradeLevel}` : ''}</option>)}</select></div>
              <div><label htmlFor="pickup-name" className="mb-1 block text-sm font-semibold dark:text-slate-200">Contact name</label><input id="pickup-name" required maxLength={120} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 dark:border-slate-600 dark:bg-slate-800 dark:text-white" /></div>
              <div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor="pickup-relationship" className="mb-1 block text-sm font-semibold dark:text-slate-200">Relationship</label><input id="pickup-relationship" required maxLength={80} value={form.relationship} onChange={(event) => setForm((current) => ({ ...current, relationship: event.target.value }))} placeholder="Grandparent" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 dark:border-slate-600 dark:bg-slate-800 dark:text-white" /></div><div><label htmlFor="pickup-phone" className="mb-1 block text-sm font-semibold dark:text-slate-200">Phone (optional)</label><input id="pickup-phone" type="tel" maxLength={40} value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 dark:border-slate-600 dark:bg-slate-800 dark:text-white" /></div></div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setShowAdd(false)} className="min-h-11 rounded-lg border border-gray-300 px-4 font-semibold text-gray-700 hover:bg-gray-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">Cancel</button><button type="submit" disabled={busyId === 'create'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{busyId === 'create' ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />} Add for review</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
