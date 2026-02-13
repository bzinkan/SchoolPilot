import React, { useState } from 'react';
import { Plus, Trash2, School } from 'lucide-react';
import { GRADES } from './constants';

export default function HomeroomManager({ homerooms, students, staff, onAdd, onRemove }) {
  const [showForm, setShowForm] = useState(false);
  const [teacherId, setTeacherId] = useState('');
  const [teacherName, setTeacherName] = useState('');
  const [grade, setGrade] = useState('K');

  const teachers = (staff || []).filter(s => s.role === 'teacher');

  const handleSubmit = (e) => {
    e.preventDefault();
    const name = teacherId
      ? teachers.find(t => t.id === Number(teacherId))?.first_name + ' ' + teachers.find(t => t.id === Number(teacherId))?.last_name
      : teacherName.trim();
    if (!name) return;
    onAdd(`${name} - Grade ${grade}`, name, grade, teacherId ? Number(teacherId) : null);
    setTeacherId('');
    setTeacherName('');
    setShowForm(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Create Homerooms</h2>
          <p className="text-gray-500 text-sm">Add homeroom classes. Students will be assigned in the next tab.</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
          <Plus className="w-4 h-4" /> Add Homeroom
        </button>
      </div>

      {/* Quick Add */}
      <div className="bg-white rounded-xl border p-4">
        <p className="text-sm text-gray-600 mb-3">Quick add by grade:</p>
        <div className="flex flex-wrap gap-2">
          {GRADES.map(g => (
            <button key={g} onClick={() => { setGrade(g); setShowForm(true); }}
              className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">
              <Plus className="w-3 h-3 inline mr-1" /> Grade {g}
            </button>
          ))}
        </div>
      </div>

      {/* Add Form */}
      {showForm && (
        <div className="bg-white rounded-xl border p-4">
          <form onSubmit={handleSubmit} className="flex items-end gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Teacher *</label>
              {teachers.length > 0 ? (
                <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg" autoFocus>
                  <option value="">Select a teacher...</option>
                  {teachers.map(t => (
                    <option key={t.id} value={t.id}>{t.first_name} {t.last_name} ({t.email})</option>
                  ))}
                </select>
              ) : (
                <div>
                  <input type="text" value={teacherName} onChange={(e) => setTeacherName(e.target.value)}
                    placeholder="Teacher name" className="w-full px-3 py-2 border rounded-lg" autoFocus />
                  <p className="text-xs text-amber-600 mt-1">No teachers in Staff tab yet. Add staff first for best results.</p>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
              <select value={grade} onChange={(e) => setGrade(e.target.value)} className="px-3 py-2 border rounded-lg">
                {GRADES.map(g => <option key={g} value={g}>Grade {g}</option>)}
              </select>
            </div>
            <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
              Add
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">
              Cancel
            </button>
          </form>
        </div>
      )}

      {/* Homeroom Cards */}
      {homerooms.length > 0 ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {homerooms.map(hr => {
            const count = students.filter(s => s.homeroom === hr.id).length;
            return (
              <div key={hr.id} className="bg-white rounded-xl border p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
                    <School className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <p className="font-medium">{hr.teacher || hr.name}</p>
                    <p className="text-sm text-gray-500">Grade {hr.grade} · {count} student{count !== 1 ? 's' : ''}</p>
                  </div>
                </div>
                <button onClick={() => onRemove(hr.id)} className="text-gray-400 hover:text-red-600">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white rounded-xl border p-12 text-center">
          <School className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No homerooms created yet</p>
          <p className="text-sm text-gray-400">Click a grade button above to add your first homeroom</p>
        </div>
      )}
    </div>
  );
}
