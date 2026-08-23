import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, X, AlertCircle, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import api from '../../../shared/utils/api';

/** Safely extract an array from API response data (handles wrapped objects). */
const toArray = (data, key) => Array.isArray(data) ? data : (data?.[key] ?? []);
const toStudentMutation = (data = {}) => Object.fromEntries(Object.entries({
  id: data.id,
  firstName: data.firstName ?? data.first_name,
  lastName: data.lastName ?? data.last_name,
  email: data.email,
  gradeLevel: data.gradeLevel ?? data.grade_level ?? data.grade,
  dismissalType: data.dismissalType ?? data.dismissal_type,
  busRoute: data.busRoute ?? data.bus_route,
  afterschoolReason: data.afterschoolReason ?? data.afterschool_reason,
  homeroomId: data.homeroomId ?? data.homeroom_id,
  studentIdNumber: data.studentIdNumber ?? data.student_id_number,
  externalId: data.externalId ?? data.external_id,
}).filter(([, value]) => value !== undefined));
import { normalizeStudent, normalizeStaff, tabs } from './setup/constants';
import StaffManager from './setup/StaffManager';
import StudentRoster from './setup/StudentRoster';
import HomeroomManager from './setup/HomeroomManager';
import AssignStudents from './setup/AssignStudents';
import BusAssignments from './setup/BusAssignments';
import DismissalConfig from './setup/DismissalConfig';
import CarNumbersTab from './setup/CarNumbersTab';
import AuthorizedPickupsTab from './setup/AuthorizedPickupsTab';
import SchoolSettingsTab from './setup/SchoolSettingsTab';


export default function SchoolSetupWizard() {
  const navigate = useNavigate();
  const { currentSchool, currentRole, currentRoles } = useGoPilotAuth();
  const canManageSetup = currentRoles.some((role) => role === 'admin' || role === 'school_admin');
  const canManagePickups = canManageSetup || currentRoles.includes('office_staff');
  const teacherOnly = currentRoles.includes('teacher') && !canManagePickups;

  const [activeTab, setActiveTab] = useState(
    currentRoles.includes('office_staff') && !canManageSetup ? 'pickups' : 'staff'
  );
  const [students, setStudents] = useState([]);
  const [homerooms, setHomerooms] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [, setSavingIds] = useState(new Set());
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [showCreateSchool, setShowCreateSchool] = useState(!currentSchool);

  const schoolId = currentSchool?.id;
  const schoolName = currentSchool?.name || '';

  const requestSetupNavigation = (nextTabOrPath, { route = false } = {}) => {
    if (!route && nextTabOrPath === activeTab) return;
    if (activeTab === 'settings' && settingsDirty) {
      const discard = window.confirm('Discard unsaved GoPilot settings or instructional calendar changes?');
      if (!discard) return;
    }
    setSettingsDirty(false);
    if (route) navigate(nextTabOrPath);
    else setActiveTab(nextTabOrPath);
  };

  useEffect(() => {
    if (!currentRole || canManagePickups) return;
    navigate(teacherOnly ? '/gopilot/teacher' : '/gopilot', { replace: true });
  }, [canManagePickups, currentRole, navigate, teacherOnly]);

  // Fetch data on mount
  useEffect(() => {
    if (!schoolId) { setShowCreateSchool(true); return; }
    if (!canManagePickups) return;
    setShowCreateSchool(false);
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!canManageSetup) {
          // AuthorizedPickupsTab owns its narrow data load for office staff.
          setStudents([]);
          setHomerooms([]);
          setStaff([]);
          return;
        }
        const [studentsRes, homeroomsRes, staffRes] = await Promise.all([
          api.get('/gopilot/students'),
          api.get(`/schools/${schoolId}/homerooms`),
          api.get(`/schools/${schoolId}/staff`).catch(() => ({ data: [] })),
        ]);
        setStudents(toArray(studentsRes.data, 'students').map(normalizeStudent));
        setHomerooms(toArray(homeroomsRes.data, 'homerooms'));
        setStaff(toArray(staffRes.data, 'staff').map(normalizeStaff));
      } catch (err) {
        console.error('Failed to load school data:', err);
        setError('Failed to load school data. Please try again.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [canManagePickups, canManageSetup, schoolId]);

  // Student CRUD
  const handleAddStudent = async (data) => {
    setError(null);
    try {
      const res = await api.post('/gopilot/students', toStudentMutation(data));
      setStudents(prev => [...prev, normalizeStudent(res.data?.student || res.data)]);
      return true;
    } catch (err) {
      console.error('Failed to add student:', err);
      setError('Failed to add student.');
      return false;
    }
  };

  const handleUpdateStudent = async (id, data) => {
    setError(null);
    setSavingIds(prev => new Set(prev).add(id));
    try {
      await api.patch(`/gopilot/students/${id}`, toStudentMutation(data));
      const studentsRes = await api.get('/gopilot/students');
      setStudents(toArray(studentsRes.data, 'students').map(normalizeStudent));
      return true;
    } catch (err) {
      console.error('Failed to update student:', err);
      setError('Failed to update student.');
      return false;
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const handleDeleteStudent = async (id) => {
    if (!window.confirm('Delete this student record? Historical dismissal records will remain, but the active roster entry will be removed.')) return;
    setError(null);
    try {
      await api.delete(`/gopilot/students/${id}`);
      setStudents(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete student:', err);
      setError('Failed to delete student.');
    }
  };

  const handleBulkDelete = async (ids) => {
    if (!window.confirm(`Delete ${ids.length} student records? Historical dismissal records will remain.`)) return;
    setError(null);
    try {
      await Promise.all(ids.map(id => api.delete(`/gopilot/students/${id}`)));
      setStudents(prev => prev.filter(s => !ids.includes(s.id)));
    } catch (err) {
      console.error('Failed to delete students:', err);
      setError('Failed to delete some students.');
    }
  };

  const refreshStudents = async () => {
    const studentsRes = await api.get('/gopilot/students');
    setStudents(toArray(studentsRes.data, 'students').map(normalizeStudent));
  };

  const handleImportCSV = async (file) => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.post('/gopilot/students/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await refreshStudents();
    } catch (err) {
      console.error('CSV import failed:', err);
      setError('Failed to import CSV. Please check the file format.');
    }
  };

  // Homeroom CRUD
  const handleAddHomeroom = async (name, teacher, grade, teacherIdVal) => {
    setError(null);
    try {
      const res = await api.post(`/schools/${schoolId}/homerooms`, { name, grade, teacherId: teacherIdVal || null });
      const hr = res.data.homeroom || res.data;
      // Add teacher name so the card displays correctly before a full reload
      setHomerooms(prev => [...prev, { ...hr, teacher: teacher ? { name: teacher } : null }]);
    } catch (err) {
      console.error('Failed to create homeroom:', err);
      setError('Failed to create homeroom.');
    }
  };

  const handleRemoveHomeroom = async (id) => {
    if (!window.confirm('Delete this homeroom? Students will remain on the school roster.')) return;
    setError(null);
    try {
      await api.delete(`/homerooms/${id}`);
      setHomerooms(prev => prev.filter(h => h.id !== id));
      setStudents(prev => prev.map(s => s.homeroom === id ? { ...s, homeroom: null } : s));
    } catch (err) {
      console.error('Failed to delete homeroom:', err);
      setError('Failed to delete homeroom.');
    }
  };

  // Assignment
  const handleAssignStudent = async (studentId, homeroomId) => {
    setError(null);
    try {
      if (homeroomId) {
        await api.post(`/homerooms/${homeroomId}/assign`, { studentIds: [studentId] });
      } else {
        await api.patch(`/gopilot/students/${studentId}`, { homeroomId: null });
      }
      setStudents(prev => prev.map(s => s.id === studentId ? { ...s, homeroom: homeroomId } : s));
    } catch (err) {
      console.error('Failed to assign student:', err);
      setError('Failed to assign student.');
    }
  };

  // Dismissal
  const handleUpdateDismissal = async (studentId, field, value) => {
    setError(null);
    setSavingIds(prev => new Set(prev).add(studentId));
    try {
      const payload = { [field]: value };
      // Clear busRoute when changing away from bus
      if (field === 'dismissalType' && value !== 'bus') {
        payload.busRoute = null;
      }
      await api.patch(`/gopilot/students/${studentId}`, payload);
      setStudents(prev => prev.map(s => {
        if (s.id !== studentId) return s;
        const updated = { ...s, [field]: value };
        if (field === 'dismissalType' && value !== 'bus') updated.busRoute = '';
        return updated;
      }));
    } catch (err) {
      console.error('Failed to update dismissal:', err);
      setError('Failed to update dismissal.');
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(studentId); return n; });
    }
  };

  const handleBulkSetDismissal = async (type) => {
    setError(null);
    try {
      const updates = students.map(s => ({
        id: s.id,
        dismissalType: type,
        busRoute: type === 'bus' ? (s.busRoute || null) : null,
      }));
      await api.patch('/gopilot/students/bulk', { updates });
      setStudents(prev => prev.map(s => ({
        ...s,
        dismissalType: type,
        busRoute: type === 'bus' ? s.busRoute : '',
      })));
    } catch (err) {
      console.error('Failed to bulk update:', err);
      setError('Failed to update some students.');
    }
  };

  // No school
  if (showCreateSchool) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border dark:border-slate-700 p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Car className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Welcome to GoPilot</h1>
          <p className="text-gray-500 dark:text-slate-400 mb-6">Your school is pending approval. You will receive an email once your account has been approved.</p>
          <button onClick={() => navigate('/login')} className="px-4 py-2 border dark:border-slate-600 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-300">
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  if (schoolId && !canManagePickups) {
    return null;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600 dark:text-slate-400">Loading school data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b dark:border-slate-700">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
              <Car className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-gray-900 dark:text-white">GoPilot Setup</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400">{schoolName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {[

              { id: 'pickups', icon: ShieldCheck, label: 'Authorized Pickups' },
              ...(canManageSetup ? [{ id: 'settings', icon: Settings, label: 'Settings' }] : []),
            // eslint-disable-next-line no-unused-vars
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => requestSetupNavigation(id)}
                className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-sm transition-colors ${
                  activeTab === id
                    ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400'
                    : 'border-gray-200 dark:border-slate-600 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                }`}
                title={label}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
            <button onClick={() => requestSetupNavigation(teacherOnly ? '/gopilot/teacher' : '/gopilot', { route: true })} className="px-4 py-2 text-sm text-gray-600 dark:text-slate-300 border dark:border-slate-600 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800">
              Back to Dashboard
            </button>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-white dark:bg-slate-900 border-b dark:border-slate-700">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1 overflow-x-auto scrollbar-hide" style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
            {(canManageSetup ? tabs : []).map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => requestSetupNavigation(tab.id)}
                  className={`flex items-center gap-2 px-3 sm:px-4 py-3 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap transition-colors flex-shrink-0 ${
                    isActive
                      ? 'border-indigo-600 text-indigo-600'
                      : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300 dark:hover:border-slate-600'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg flex items-center gap-3 text-red-700 dark:text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <p>{error}</p>
            <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
          </div>
        )}

        {canManageSetup && activeTab === 'staff' && (
          <StaffManager
            staff={staff}
            schoolId={schoolId}
            onAdd={async (data) => {
              const res = await api.post(`/schools/${schoolId}/staff`, data);
              const created = normalizeStaff(res.data);
              if (!created.id) throw new Error('The server did not return a staff membership ID.');
              setStaff(prev => [...prev.filter(s => s.id !== created.id), created]);
            }}
            onRemove={async (membershipId) => {
              if (!window.confirm('Remove this staff member from the school? They will immediately lose access to every SchoolPilot product at this school.')) return;
              await api.delete(`/schools/${schoolId}/staff/${membershipId}`);
              setStaff(prev => prev.filter(s => s.id !== membershipId));
            }}
            onUpdate={async (membershipId, data) => {
              await api.put(`/schools/${schoolId}/staff/${membershipId}`, data);
              const res = await api.get(`/schools/${schoolId}/staff`);
              setStaff(toArray(res.data, 'staff').map(normalizeStaff));
            }}
            onRefresh={async () => {
              const res = await api.get(`/schools/${schoolId}/staff`);
              setStaff(toArray(res.data, 'staff').map(normalizeStaff));
            }}
          />
        )}
        {canManageSetup && activeTab === 'roster' && (
          <StudentRoster
            students={students}
            schoolId={schoolId}
            onImport={handleImportCSV}
            onRefresh={refreshStudents}
            onAdd={handleAddStudent}
            onUpdate={handleUpdateStudent}
            onDelete={handleDeleteStudent}
            onBulkDelete={handleBulkDelete}
          />
        )}
        {canManageSetup && activeTab === 'homerooms' && (
          <HomeroomManager
            homerooms={homerooms}
            students={students}
            staff={staff}
            onAdd={handleAddHomeroom}
            onRemove={handleRemoveHomeroom}
          />
        )}
        {canManageSetup && activeTab === 'assign' && (
          <AssignStudents
            students={students}
            homerooms={homerooms}
            onAssign={handleAssignStudent}
            schoolId={schoolId}
            onRefreshStudents={async () => {
              const res = await api.get('/gopilot/students');
              setStudents(toArray(res.data, 'students').map(normalizeStudent));
            }}
          />
        )}
        {canManageSetup && activeTab === 'bus-assignments' && (
          <BusAssignments
            students={students}
            homerooms={homerooms}
            onUpdateStudents={async (updates) => {
              await api.patch('/gopilot/students/bulk', { updates: updates.map(toStudentMutation) });
              const res = await api.get('/gopilot/students');
              setStudents(toArray(res.data, 'students').map(normalizeStudent));
            }}
            onUpdateStudent={async (id, data) => {
              await api.patch(`/gopilot/students/${id}`, toStudentMutation(data));
              setStudents(prev => prev.map(s => s.id === id ? { ...s, ...normalizeStudent({ ...s, ...data }) } : s));
            }}
          />
        )}
        {canManageSetup && activeTab === 'dismissal' && (
          <DismissalConfig
            students={students}
            homerooms={homerooms}
            onUpdate={handleUpdateDismissal}
            onBulkSet={handleBulkSetDismissal}
          />
        )}

        {canManageSetup && activeTab === 'car-numbers' && (
          <CarNumbersTab schoolId={schoolId} students={students} />
        )}
        {activeTab === 'pickups' && (
          <AuthorizedPickupsTab schoolId={schoolId} />
        )}
        {activeTab === 'settings' && (
          <SchoolSettingsTab schoolId={schoolId} onDirtyChange={setSettingsDirty} />
        )}
      </main>
    </div>
  );
}
