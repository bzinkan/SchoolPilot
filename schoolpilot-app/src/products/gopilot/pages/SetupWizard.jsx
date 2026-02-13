import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, X, AlertCircle, RefreshCw } from 'lucide-react';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import api from '../../../shared/utils/api';
import { normalizeStudent, tabs } from './setup/constants';
import StaffManager from './setup/StaffManager';
import StudentRoster from './setup/StudentRoster';
import HomeroomManager from './setup/HomeroomManager';
import AssignStudents from './setup/AssignStudents';
import BusAssignments from './setup/BusAssignments';
import DismissalConfig from './setup/DismissalConfig';
import CarNumbersTab from './setup/CarNumbersTab';
import ParentsTab from './setup/ParentsTab';
import SchoolSettingsTab from './setup/SchoolSettingsTab';
import ReviewLaunch from './setup/ReviewLaunch';

export default function SchoolSetupWizard() {
  const navigate = useNavigate();
  const { currentSchool, user } = useGoPilotAuth();

  const [activeTab, setActiveTab] = useState('staff');
  const [students, setStudents] = useState([]);
  const [homerooms, setHomerooms] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [savingIds, setSavingIds] = useState(new Set());

  const [googleConnected, setGoogleConnected] = useState(false);

  const [showCreateSchool, setShowCreateSchool] = useState(!currentSchool);
  const [newSchoolName, setNewSchoolName] = useState('');
  const [creatingSchool, setCreatingSchool] = useState(false);

  const schoolId = currentSchool?.id;
  const schoolName = currentSchool?.name || '';

  // Fetch data on mount
  useEffect(() => {
    if (!schoolId) { setShowCreateSchool(true); return; }
    setShowCreateSchool(false);
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [studentsRes, homeroomsRes, staffRes] = await Promise.all([
          api.get(`/schools/${schoolId}/students`),
          api.get(`/schools/${schoolId}/homerooms`),
          api.get(`/schools/${schoolId}/staff`).catch(() => ({ data: [] })),
        ]);
        setStudents((studentsRes.data || []).map(normalizeStudent));
        setHomerooms(homeroomsRes.data || []);
        setStaff(staffRes.data || []);
        // Check Google Classroom connection status
        try {
          const gRes = await api.get(`/schools/${schoolId}/google/status`);
          setGoogleConnected(gRes.data.connected);
        } catch { /* ignore */ }
      } catch (err) {
        console.error('Failed to load school data:', err);
        setError('Failed to load school data. Please try again.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [schoolId]);

  // Create school handler
  const handleCreateSchool = async (e) => {
    e.preventDefault();
    if (!newSchoolName.trim()) return;
    setCreatingSchool(true);
    setError(null);
    try {
      await api.post('/schools', { name: newSchoolName.trim() });
      window.location.reload();
    } catch (err) {
      console.error('Failed to create school:', err);
      setError('Failed to create school. Please try again.');
      setCreatingSchool(false);
    }
  };

  // Student CRUD
  const handleAddStudent = async (data) => {
    setError(null);
    try {
      const res = await api.post(`/schools/${schoolId}/students`, data);
      setStudents(prev => [...prev, normalizeStudent(res.data)]);
    } catch (err) {
      console.error('Failed to add student:', err);
      setError('Failed to add student.');
    }
  };

  const handleUpdateStudent = async (id, data) => {
    setError(null);
    setSavingIds(prev => new Set(prev).add(id));
    try {
      await api.put(`/students/${id}`, data);
      const studentsRes = await api.get(`/schools/${schoolId}/students`);
      setStudents((studentsRes.data || []).map(normalizeStudent));
    } catch (err) {
      console.error('Failed to update student:', err);
      setError('Failed to update student.');
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const handleDeleteStudent = async (id) => {
    setError(null);
    try {
      await api.delete(`/students/${id}`);
      setStudents(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete student:', err);
      setError('Failed to delete student.');
    }
  };

  const handleBulkDelete = async (ids) => {
    setError(null);
    try {
      await Promise.all(ids.map(id => api.delete(`/students/${id}`)));
      setStudents(prev => prev.filter(s => !ids.includes(s.id)));
    } catch (err) {
      console.error('Failed to delete students:', err);
      setError('Failed to delete some students.');
    }
  };

  const refreshStudents = async () => {
    const studentsRes = await api.get(`/schools/${schoolId}/students`);
    setStudents((studentsRes.data || []).map(normalizeStudent));
  };

  const handleImportCSV = async (file) => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.post(`/schools/${schoolId}/students/import`, formData, {
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
      setHomerooms(prev => [...prev, res.data]);
    } catch (err) {
      console.error('Failed to create homeroom:', err);
      setError('Failed to create homeroom.');
    }
  };

  const handleRemoveHomeroom = async (id) => {
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
        await api.put(`/students/${studentId}`, { homeroom_id: null });
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
    const fieldMap = { dismissalType: 'dismissal_type', busRoute: 'bus_route' };
    const apiField = fieldMap[field] || field;
    try {
      const payload = { [apiField]: value };
      // Clear bus_route when changing away from bus
      if (field === 'dismissalType' && value !== 'bus') {
        payload.bus_route = null;
      }
      await api.put(`/students/${studentId}`, payload);
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
        dismissal_type: type,
        bus_route: type === 'bus' ? (s.busRoute || null) : null,
      }));
      await api.put(`/schools/${schoolId}/students/bulk-update`, { updates });
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-xl shadow-sm border p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Car className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome to GoPilot</h1>
          <p className="text-gray-500 mb-6">Your school is pending approval. You will receive an email once your account has been approved.</p>
          <button onClick={() => navigate('/login')} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading school data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
              <Car className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-gray-900">GoPilot Setup</h1>
              <p className="text-sm text-gray-500">{schoolName}</p>
            </div>
          </div>
          <button onClick={() => navigate('/gopilot')} className="px-4 py-2 text-sm text-gray-600 border rounded-lg hover:bg-gray-50">
            Back to Dashboard
          </button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1 overflow-x-auto">
            {tabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-indigo-600 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <p>{error}</p>
            <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
          </div>
        )}

        {activeTab === 'staff' && (
          <StaffManager
            staff={staff}
            schoolId={schoolId}
            googleConnected={googleConnected}
            onAdd={async (data) => {
              const res = await api.post(`/schools/${schoolId}/staff`, data);
              setStaff(prev => [...prev.filter(s => s.id !== res.data.id), res.data]);
            }}
            onRemove={async (userId) => {
              await api.delete(`/schools/${schoolId}/staff/${userId}`);
              setStaff(prev => prev.filter(s => s.id !== userId));
            }}
            onUpdate={async (userId, data) => {
              await api.put(`/schools/${schoolId}/staff/${userId}`, data);
              const res = await api.get(`/schools/${schoolId}/staff`);
              setStaff(res.data || []);
            }}
            onRefresh={async () => {
              const res = await api.get(`/schools/${schoolId}/staff`);
              setStaff(res.data || []);
            }}
          />
        )}
        {activeTab === 'roster' && (
          <StudentRoster
            students={students}
            schoolId={schoolId}
            onImport={handleImportCSV}
            onRefresh={refreshStudents}
            onAdd={handleAddStudent}
            onUpdate={handleUpdateStudent}
            onDelete={handleDeleteStudent}
            onBulkDelete={handleBulkDelete}
            googleConnected={googleConnected}
          />
        )}
        {activeTab === 'homerooms' && (
          <HomeroomManager
            homerooms={homerooms}
            students={students}
            staff={staff}
            onAdd={handleAddHomeroom}
            onRemove={handleRemoveHomeroom}
          />
        )}
        {activeTab === 'assign' && (
          <AssignStudents
            students={students}
            homerooms={homerooms}
            onAssign={handleAssignStudent}
            schoolId={schoolId}
            googleConnected={googleConnected}
            setGoogleConnected={setGoogleConnected}
            onRefreshStudents={async () => {
              const res = await api.get(`/schools/${schoolId}/students`);
              setStudents((res.data || []).map(normalizeStudent));
            }}
          />
        )}
        {activeTab === 'bus-assignments' && (
          <BusAssignments
            students={students}
            homerooms={homerooms}
            onUpdateStudents={async (updates) => {
              await api.put(`/schools/${schoolId}/students/bulk-update`, { updates });
              const res = await api.get(`/schools/${schoolId}/students`);
              setStudents((res.data || []).map(normalizeStudent));
            }}
            onUpdateStudent={async (id, data) => {
              await api.put(`/students/${id}`, data);
              setStudents(prev => prev.map(s => s.id === id ? { ...s, ...normalizeStudent({ ...s, ...data }) } : s));
            }}
          />
        )}
        {activeTab === 'dismissal' && (
          <DismissalConfig
            students={students}
            homerooms={homerooms}
            schoolId={schoolId}
            onUpdate={handleUpdateDismissal}
            onBulkSet={handleBulkSetDismissal}
          />
        )}
        {activeTab === 'review' && (
          <ReviewLaunch
            students={students}
            homerooms={homerooms}
            onLaunch={() => navigate('/gopilot')}
          />
        )}
        {activeTab === 'car-numbers' && (
          <CarNumbersTab schoolId={schoolId} students={students} />
        )}
        {activeTab === 'parents' && (
          <ParentsTab schoolId={schoolId} />
        )}
        {activeTab === 'settings' && (
          <SchoolSettingsTab schoolId={schoolId} />
        )}
      </main>
    </div>
  );
}
