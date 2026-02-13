import React, { useState } from 'react';
import { X, School, ChevronRight, ChevronDown, Search, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { GoogleLogo } from './constants';

export default function AssignStudents({ students, homerooms, onAssign, schoolId, googleConnected, setGoogleConnected, onRefreshStudents }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedHomeroom, setExpandedHomeroom] = useState(null);
  const [courses, setCourses] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [showCourses, setShowCourses] = useState(false);
  const [courseMapping, setCourseMapping] = useState({});
  const [courseGrades, setCourseGrades] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [gradeFilter, setGradeFilter] = useState(null);
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [bulkHomeroom, setBulkHomeroom] = useState('');
  const [bulkAssigning, setBulkAssigning] = useState(false);

  const allUnassigned = students.filter(s => !s.homeroom);
  const grades = [...new Set(allUnassigned.map(s => s.grade).filter(Boolean))].sort((a, b) => {
    if (a === 'K') return -1;
    if (b === 'K') return 1;
    return parseInt(a) - parseInt(b);
  });
  const unassigned = allUnassigned.filter(s =>
    (!gradeFilter || s.grade === gradeFilter) &&
    `${s.firstName} ${s.lastName}`.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleGradeFilter = (grade) => {
    setGradeFilter(grade);
    setSelectedStudents(new Set());
  };

  const toggleStudent = (id) => {
    setSelectedStudents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedStudents.size === unassigned.length) {
      setSelectedStudents(new Set());
    } else {
      setSelectedStudents(new Set(unassigned.map(s => s.id)));
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkHomeroom || selectedStudents.size === 0) return;
    setBulkAssigning(true);
    try {
      for (const studentId of selectedStudents) {
        await onAssign(studentId, parseInt(bulkHomeroom));
      }
      setSelectedStudents(new Set());
      setBulkHomeroom('');
    } catch (err) {
      console.error('Bulk assign failed:', err);
    }
    setBulkAssigning(false);
  };

  const handleConnectGoogle = async () => {
    try {
      const res = await api.get(`/schools/${schoolId}/google/auth-url`);
      window.location.href = res.data.url;
    } catch (err) {
      console.error('Failed to get Google auth URL:', err);
    }
  };

  const handleLoadCourses = async () => {
    setLoadingCourses(true);
    try {
      const res = await api.get(`/schools/${schoolId}/google/courses`);
      setCourses(res.data);
      setShowCourses(true);
    } catch (err) {
      console.error('Failed to load courses:', err);
      if (err.response?.status === 401) {
        setGoogleConnected(false);
      }
    } finally {
      setLoadingCourses(false);
    }
  };

  const handleSync = async () => {
    const selected = Object.entries(courseMapping)
      .filter(([_, homeroomId]) => homeroomId)
      .map(([courseId, homeroomId]) => ({ courseId, homeroomId: parseInt(homeroomId), grade: courseGrades[courseId] || null }));

    if (selected.length === 0) return;

    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api.post(`/schools/${schoolId}/google/sync`, { courses: selected });
      setSyncResult(res.data);
      await onRefreshStudents();
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.delete(`/schools/${schoolId}/google/disconnect`);
      setGoogleConnected(false);
      setCourses([]);
      setShowCourses(false);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Assign Students to Homerooms</h2>
          <p className="text-gray-500 text-sm">Use the dropdown to assign each student, or sync from Google Classroom.</p>
        </div>
      </div>

      {/* Google Classroom Sync */}
      <div className="bg-white rounded-xl border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GoogleLogo className="w-6 h-6" />
            <div>
              <p className="font-medium">Google Classroom Sync</p>
              <p className="text-sm text-gray-500">
                {googleConnected
                  ? 'Connected — pull students from your Google Classroom courses'
                  : 'Connect your Google account to import students from Classroom'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {googleConnected ? (
              <>
                <button onClick={handleLoadCourses} disabled={loadingCourses}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-indigo-300">
                  {loadingCourses ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {loadingCourses ? 'Loading...' : 'Load Courses'}
                </button>
                <button onClick={handleDisconnect}
                  className="px-3 py-2 border rounded-lg text-sm text-red-600 hover:bg-red-50">
                  Disconnect
                </button>
              </>
            ) : (
              <button onClick={handleConnectGoogle}
                className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg text-sm font-medium hover:bg-gray-50 shadow-sm">
                <GoogleLogo className="w-4 h-4" />
                Connect Google Classroom
              </button>
            )}
          </div>
        </div>

        {/* Course List */}
        {showCourses && courses.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <p className="text-sm font-medium text-gray-700 mb-3">
              Map Google Classroom courses to homerooms:
            </p>
            <div className="space-y-2">
              {courses.map(course => (
                <div key={course.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium">{course.name}</p>
                    {course.section && <p className="text-xs text-gray-500">{course.section}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={courseGrades[course.id] || ''}
                      onChange={e => setCourseGrades(prev => ({ ...prev, [course.id]: e.target.value }))}
                      className="text-sm border rounded-lg px-2 py-1.5"
                    >
                      <option value="">Grade</option>
                      {['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(g => (
                        <option key={g} value={g}>{g === 'K' ? 'Kindergarten' : `Grade ${g}`}</option>
                      ))}
                    </select>
                    <select
                      value={courseMapping[course.id] || ''}
                      onChange={e => setCourseMapping(prev => ({ ...prev, [course.id]: e.target.value }))}
                      className="text-sm border rounded-lg px-2 py-1.5"
                    >
                      <option value="">Skip (don't sync)</option>
                      {homerooms.map(hr => (
                        <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={handleSync} disabled={syncing || !Object.values(courseMapping).some(v => v)}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:bg-green-300 disabled:cursor-not-allowed">
                {syncing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {syncing ? 'Syncing...' : 'Sync Selected Courses'}
              </button>
              <button onClick={() => setShowCourses(false)} className="text-sm text-gray-500 hover:text-gray-700">
                Hide
              </button>
            </div>
          </div>
        )}

        {showCourses && courses.length === 0 && !loadingCourses && (
          <div className="mt-4 border-t pt-4 text-center text-sm text-gray-500">
            No active courses found. Make sure you're signed in with a teacher account.
          </div>
        )}

        {/* Sync Result */}
        {syncResult && (
          <div className="mt-4 border-t pt-4">
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm font-medium text-green-800">
                Sync complete — {syncResult.totalImported} new student{syncResult.totalImported !== 1 ? 's' : ''} imported
              </p>
              <div className="mt-2 space-y-1">
                {syncResult.results.map((r, i) => (
                  <p key={i} className="text-xs text-green-700">
                    {r.courseName}: {r.studentsFound} found, {r.studentsImported} new
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Unassigned */}
        <div className="bg-white rounded-xl border">
          <div className="p-4 border-b space-y-3">
            <h3 className="font-semibold">Unassigned ({allUnassigned.length})</h3>
            {/* Grade Tabs */}
            {grades.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => handleGradeFilter(null)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    !gradeFilter ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  All ({allUnassigned.length})
                </button>
                {grades.map(g => {
                  const count = allUnassigned.filter(s => s.grade === g).length;
                  return (
                    <button key={g} onClick={() => handleGradeFilter(g)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                        gradeFilter === g ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {g === 'K' ? 'K' : `Gr ${g}`} ({count})
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Search..." value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm" />
            </div>
          </div>

          {/* Bulk Assign Bar */}
          {selectedStudents.size > 0 && (
            <div className="px-4 py-3 bg-indigo-50 border-b flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-indigo-700">{selectedStudents.size} selected</span>
              <select value={bulkHomeroom} onChange={(e) => setBulkHomeroom(e.target.value)}
                className="text-sm border rounded-lg px-2 py-1.5 flex-1 min-w-0">
                <option value="">Assign to...</option>
                {homerooms
                  .filter(hr => !gradeFilter || hr.grade === gradeFilter)
                  .map(hr => (
                    <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                  ))}
                {gradeFilter && homerooms.filter(hr => hr.grade !== gradeFilter).length > 0 && (
                  <optgroup label="Other grades">
                    {homerooms.filter(hr => hr.grade !== gradeFilter).map(hr => (
                      <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button onClick={handleBulkAssign} disabled={!bulkHomeroom || bulkAssigning}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-indigo-300 whitespace-nowrap">
                {bulkAssigning ? 'Assigning...' : `Assign ${selectedStudents.size}`}
              </button>
            </div>
          )}

          <div className="p-4 max-h-96 overflow-y-auto">
            {unassigned.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-2" />
                <p className="text-green-600 font-medium">
                  {allUnassigned.length === 0 ? 'All students assigned!' : 'No students match this filter.'}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {/* Select All */}
                <label className="flex items-center gap-2 p-2 text-sm text-gray-500 cursor-pointer hover:bg-gray-50 rounded-lg">
                  <input type="checkbox"
                    checked={selectedStudents.size === unassigned.length && unassigned.length > 0}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                  Select all ({unassigned.length})
                </label>
                {unassigned.map(student => (
                  <div key={student.id} className={`flex items-center justify-between p-2 rounded-lg ${
                    selectedStudents.has(student.id) ? 'bg-indigo-50 border border-indigo-200' : 'bg-gray-50'
                  }`}>
                    <div className="flex items-center gap-2">
                      <input type="checkbox"
                        checked={selectedStudents.has(student.id)}
                        onChange={() => toggleStudent(student.id)}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                      <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 text-xs font-medium">
                        {(student.firstName || '?')[0]}{(student.lastName || '?')[0]}
                      </div>
                      <div>
                        <span className="text-sm font-medium">{student.firstName} {student.lastName}</span>
                        {student.grade && <span className="text-xs text-gray-400 ml-2">Gr {student.grade}</span>}
                      </div>
                    </div>
                    <select onChange={(e) => onAssign(student.id, parseInt(e.target.value))} defaultValue=""
                      className="text-sm border rounded px-2 py-1">
                      <option value="" disabled>Assign to...</option>
                      {homerooms.map(hr => (
                        <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Homerooms */}
        <div className="bg-white rounded-xl border">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Homerooms</h3>
          </div>
          <div className="divide-y max-h-96 overflow-y-auto">
            {homerooms.map(hr => {
              const hStudents = students.filter(s => s.homeroom === hr.id);
              const expanded = expandedHomeroom === hr.id;
              return (
                <div key={hr.id}>
                  <button onClick={() => setExpandedHomeroom(expanded ? null : hr.id)}
                    className="w-full flex items-center justify-between p-4 hover:bg-gray-50">
                    <div className="flex items-center gap-3">
                      <School className="w-5 h-5 text-indigo-600" />
                      <div className="text-left">
                        <p className="font-medium">{hr.teacher || hr.name}</p>
                        <p className="text-sm text-gray-500">Grade {hr.grade}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs font-medium">
                        {hStudents.length}
                      </span>
                      {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </button>
                  {expanded && (
                    <div className="px-4 pb-4">
                      <div className="bg-gray-50 rounded-lg p-3 space-y-1">
                        {hStudents.length === 0 ? (
                          <p className="text-sm text-gray-400 text-center py-2">No students assigned</p>
                        ) : (
                          hStudents.map(s => (
                            <div key={s.id} className="flex items-center justify-between text-sm">
                              <span>{s.firstName} {s.lastName}</span>
                              <button onClick={() => onAssign(s.id, null)} className="text-red-500 hover:text-red-700">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
