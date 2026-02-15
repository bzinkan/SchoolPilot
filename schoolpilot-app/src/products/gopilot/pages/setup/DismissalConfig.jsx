import React, { useState } from 'react';
import { Car, Bus, PersonStanding, Clock, CheckCircle2, Save } from 'lucide-react';
import api from '../../../../shared/utils/api';

export default function DismissalConfig({ students, homerooms, schoolId, onUpdate, onBulkSet }) {
  const [filterHomeroom, setFilterHomeroom] = useState('all');
  const [showBulkOptions, setShowBulkOptions] = useState(false);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const dismissalTypes = [
    { id: 'car', label: 'Car', icon: Car, color: 'blue' },
    { id: 'bus', label: 'Bus', icon: Bus, color: 'yellow' },
    { id: 'walker', label: 'Walker', icon: PersonStanding, color: 'green' },
    { id: 'afterschool', label: 'After School', icon: Clock, color: 'purple' },
  ];

  const filtered = students.filter(s =>
    filterHomeroom === 'all' || s.homeroom === parseInt(filterHomeroom)
  );

  const busStudentCount = students.filter(s => s.dismissalType === 'bus' && s.busRoute).length;

  const handleSaveHomeroom = async () => {
    if (filterHomeroom === 'all' || saving) return;
    setSaving(true);
    try {
      const homeroomStudents = students.filter(s => s.homeroom === parseInt(filterHomeroom));
      const updates = homeroomStudents.map(s => ({
        id: s.id,
        dismissal_type: s.dismissalType,
        bus_route: s.dismissalType === 'bus' ? (s.busRoute || null) : null,
      }));
      await api.put(`/schools/${schoolId}/students/bulk-update`, { updates });
      showToast(`Saved ${updates.length} students`);
    } catch (err) {
      console.error('Failed to save homeroom:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
          <CheckCircle2 className="w-4 h-4" /> {toast}
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Set Dismissal Types</h2>
        <p className="text-gray-500 dark:text-slate-400 text-sm">Choose how each student goes home.</p>
      </div>

      {/* Bus students info banner */}
      {busStudentCount > 0 && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-3 flex items-center gap-2">
          <Bus className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-800 dark:text-yellow-400">
            {busStudentCount} student{busStudentCount !== 1 ? 's' : ''} already assigned to buses from the Bus Assignments step.
          </p>
        </div>
      )}

      {/* Bulk + Filter + Save */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 dark:text-slate-300">Filter:</label>
          <select value={filterHomeroom} onChange={(e) => setFilterHomeroom(e.target.value)}
            className="border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg px-3 py-1.5 text-sm">
            <option value="all">All homerooms</option>
            {homerooms.map(hr => (
              <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {filterHomeroom !== 'all' && (
            <button onClick={handleSaveHomeroom} disabled={saving}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50">
              <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Homeroom'}
            </button>
          )}
          <button onClick={() => setShowBulkOptions(!showBulkOptions)}
            className="px-3 py-1.5 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-white">
            {showBulkOptions ? 'Hide Bulk' : 'Set All'}
          </button>
        </div>
      </div>

      {showBulkOptions && (
        <div className="flex flex-wrap gap-2">
          {dismissalTypes.map(type => {
            const Icon = type.icon;
            return (
              <button key={type.id} onClick={() => onBulkSet(type.id)}
                className="flex items-center gap-1 px-3 py-1.5 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-white">
                <Icon className="w-4 h-4" /> Set all to {type.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Student list */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 overflow-hidden">
        <div className="bg-gray-50 dark:bg-slate-800 border-b dark:border-slate-700 px-4 py-3">
          <div className="grid grid-cols-12 gap-4 text-sm font-medium text-gray-500 dark:text-slate-400">
            <div className="col-span-4">Student</div>
            <div className="col-span-3">Homeroom</div>
            <div className="col-span-3">Dismissal Type</div>
            <div className="col-span-2">Bus #</div>
          </div>
        </div>
        <div className="divide-y dark:divide-slate-700 max-h-96 overflow-y-auto">
          {filtered.map(student => {
            const hr = homerooms.find(h => h.id === student.homeroom);
            return (
              <div key={student.id} className="grid grid-cols-12 gap-4 px-4 py-3 items-center">
                <div className="col-span-4 flex items-center gap-2">
                  <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                    {(student.firstName || '?')[0]}{(student.lastName || '?')[0]}
                  </div>
                  <span className="text-sm font-medium">{student.firstName} {student.lastName}</span>
                </div>
                <div className="col-span-3 text-sm text-gray-500 dark:text-slate-400">
                  {hr ? hr.teacher || hr.name : <span className="text-yellow-600 dark:text-yellow-400">Unassigned</span>}
                </div>
                <div className="col-span-3">
                  <select value={student.dismissalType}
                    onChange={(e) => onUpdate(student.id, 'dismissalType', e.target.value)}
                    className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded px-2 py-1 text-sm">
                    {dismissalTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  {student.dismissalType === 'bus' ? (
                    <input type="text" value={student.busRoute || ''}
                      onChange={(e) => onUpdate(student.id, 'busRoute', e.target.value)}
                      placeholder="Bus #" className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded px-2 py-1 text-sm" />
                  ) : (
                    <span className="text-gray-400 dark:text-slate-500 text-sm">&mdash;</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        {dismissalTypes.map(type => {
          const Icon = type.icon;
          const count = students.filter(s => s.dismissalType === type.id).length;
          const pct = students.length > 0 ? Math.round((count / students.length) * 100) : 0;
          return (
            <div key={type.id} className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4 text-center">
              <Icon className="w-6 h-6 mx-auto mb-2 text-gray-500 dark:text-slate-400" />
              <p className="text-2xl font-bold dark:text-white">{count}</p>
              <p className="text-sm text-gray-500 dark:text-slate-400">{type.label}</p>
              <p className="text-xs text-gray-400 dark:text-slate-500">{pct}%</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
