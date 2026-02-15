import React, { useState, useRef, useEffect } from 'react';
import { Upload, X, Users, Plus, Trash2, Edit, ChevronRight, Search, CheckCircle2, AlertCircle, ArrowLeft, Download, RefreshCw, Save, QrCode, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useGoPilotAuth } from '../../../../hooks/useGoPilotAuth';
import api from '../../../../shared/utils/api';
import { GoogleLogo, GRADES, PAGE_SIZE, detectGradeFromName } from './constants';

// ─── STUDENT ROSTER TAB ──────────────────────────────────────────────

export default function StudentRoster({ students, schoolId, onImport, onRefresh, onAdd, onUpdate, onDelete, onBulkDelete, googleConnected }) {
  const { currentSchool } = useGoPilotAuth();
  const [gradeFilter, setGradeFilter] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [page, setPage] = useState(1);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [isImporting, setIsImporting] = useState(false);
  const [bulkGrade, setBulkGrade] = useState('');
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [wsOrgUnits, setWsOrgUnits] = useState([]);
  const [wsUsers, setWsUsers] = useState([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsSelectedOU, setWsSelectedOU] = useState(null);
  const [wsSelectedUsers, setWsSelectedUsers] = useState(new Set());
  const [wsGradeMap, setWsGradeMap] = useState({}); // { orgUnitPath: grade } or { _default: grade }
  const [wsCheckedOUs, setWsCheckedOUs] = useState(new Set()); // checked org unit paths for bulk import
  const [wsImporting, setWsImporting] = useState(false);
  const [wsStep, setWsStep] = useState('orgunits'); // 'orgunits' | 'users'
  const [showQrPrint, setShowQrPrint] = useState(false);
  const [schoolSettings, setSchoolSettings] = useState({});
  const fileInputRef = useRef(null);

  // Load school settings for QR toggle
  useEffect(() => {
    if (!schoolId) return;
    api.get(`/schools/${schoolId}/settings`).then(r => setSchoolSettings(r.data || {})).catch(() => {});
  }, [schoolId]);

  // Get unique grades from students
  const studentGrades = [...new Set(students.map(s => s.grade || 'Unknown'))].sort((a, b) => {
    const order = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', 'Unknown'];
    return order.indexOf(String(a)) - order.indexOf(String(b));
  });

  // Filter students
  const filtered = students.filter(s => {
    const matchGrade = gradeFilter === 'All' || String(s.grade) === gradeFilter;
    const matchSearch = !searchTerm ||
      `${s.firstName} ${s.lastName} ${s.email || ''}`.toLowerCase().includes(searchTerm.toLowerCase());
    return matchGrade && matchSearch;
  });

  // Pagination
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filter changes
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(1); }, [gradeFilter, searchTerm]);

  // Grade counts
  const gradeCounts = {};
  students.forEach(s => {
    const g = String(s.grade || 'Unknown');
    gradeCounts[g] = (gradeCounts[g] || 0) + 1;
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsImporting(true);
    await onImport(file);
    setIsImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadTemplate = () => {
    const csv = 'First Name,Last Name,Grade,Email,Dismissal Type,Bus #,Student ID\nJane,Doe,3,jane@school.edu,car,,\nJohn,Smith,4,john@school.edu,bus,12,';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gopilot_student_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paged.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paged.map(s => s.id)));
    }
  };

  const startEdit = (student) => {
    setEditingId(student.id);
    setEditData({
      first_name: student.firstName,
      last_name: student.lastName,
      email: student.email || '',
      grade: student.grade || '',
      dismissal_type: student.dismissalType || 'car',
      bus_route: student.busRoute || '',
    });
  };

  const saveEdit = async () => {
    await onUpdate(editingId, editData);
    setEditingId(null);
  };

  return (
    <div className="space-y-4">
      {/* Import Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4 flex flex-wrap items-center gap-3">
        <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv" className="hidden" />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isImporting}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-indigo-300"
        >
          {isImporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {isImporting ? 'Importing...' : 'Upload CSV'}
        </button>
        <button onClick={downloadTemplate} className="flex items-center gap-2 px-4 py-2 border dark:border-slate-700 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-200">
          <Download className="w-4 h-4" />
          Download Template
        </button>
        {schoolSettings.enableQrCodes && (
          <button onClick={() => setShowQrPrint(true)} className="flex items-center gap-2 px-4 py-2 border dark:border-slate-700 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-200">
            <QrCode className="w-4 h-4" />
            Print QR Codes
          </button>
        )}
        {googleConnected ? (
          <button
            onClick={async () => {
              setShowWorkspaceModal(true);
              setWsStep('orgunits');
              setWsLoading(true);
              try {
                const res = await api.get(`/schools/${schoolId}/google/org-units`);
                setWsOrgUnits(res.data);
              } catch (err) {
                console.error('Failed to load org units:', err);
                setWsOrgUnits([]);
              }
              setWsLoading(false);
            }}
            className="flex items-center gap-2 px-4 py-2 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg text-sm font-medium text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30"
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
        <div className="ml-auto">
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
          >
            <Plus className="w-4 h-4" />
            Add Student
          </button>
        </div>
      </div>

      {/* Add Student Form */}
      {showAddForm && (
        <AddStudentForm
          onAdd={onAdd}
          onClose={() => setShowAddForm(false)}
        />
      )}

      {/* Grade Tabs + Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-gray-100 dark:bg-slate-700 rounded-lg p-1">
          <button
            onClick={() => setGradeFilter('All')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${gradeFilter === 'All' ? 'bg-white dark:bg-slate-800 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'}`}
          >
            All ({students.length})
          </button>
          {studentGrades.map(g => (
            <button
              key={g}
              onClick={() => setGradeFilter(g)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${gradeFilter === g ? 'bg-white dark:bg-slate-800 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'}`}
            >
              {g === 'Unknown' ? 'No Grade' : `Gr ${g}`} ({gradeCounts[g] || 0})
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-slate-500" />
          <input
            type="text"
            placeholder="Search students..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 border dark:border-slate-600 rounded-lg text-sm w-64 dark:bg-slate-800 dark:text-white"
          />
        </div>
      </div>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-3 flex items-center gap-3">
          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-400">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <select value={bulkGrade} onChange={e => setBulkGrade(e.target.value)}
              className="border dark:border-slate-600 rounded-lg px-2 py-1.5 text-sm dark:bg-slate-800 dark:text-white">
              <option value="">Assign grade...</option>
              {GRADES.map(g => <option key={g} value={g}>Grade {g}</option>)}
            </select>
            <button
              disabled={!bulkGrade}
              onClick={async () => {
                await Promise.all([...selectedIds].map(id => onUpdate(id, { grade: bulkGrade })));
                setSelectedIds(new Set());
                setBulkGrade('');
              }}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
            >
              Assign Grade
            </button>
          </div>
          <button
            onClick={() => { onBulkDelete([...selectedIds]); setSelectedIds(new Set()); }}
            className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700"
          >
            <Trash2 className="w-4 h-4" /> Delete Selected
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200">
            Clear Selection
          </button>
        </div>
      )}

      {/* Student Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-slate-800 border-b dark:border-slate-700">
            <tr>
              <th className="w-10 p-3">
                <input
                  type="checkbox"
                  checked={paged.length > 0 && selectedIds.size === paged.length}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
              </th>
              <th className="text-left p-3 font-medium text-gray-600 dark:text-slate-300">Name</th>
              <th className="text-left p-3 font-medium text-gray-600 dark:text-slate-300">Email</th>
              <th className="text-left p-3 font-medium text-gray-600 dark:text-slate-300">Grade</th>
              <th className="text-left p-3 font-medium text-gray-600 dark:text-slate-300">Dismissal</th>
              <th className="text-right p-3 font-medium text-gray-600 dark:text-slate-300">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-slate-700">
            {paged.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-gray-400 dark:text-slate-500">
                  <Users className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                  <p>No students found</p>
                  <p className="text-sm">Import students via CSV or add them manually</p>
                </td>
              </tr>
            ) : (
              paged.map(student => (
                editingId === student.id ? (
                  <tr key={student.id} className="bg-yellow-50 dark:bg-yellow-900/20">
                    <td className="p-3"></td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <input value={editData.first_name} onChange={e => setEditData(d => ({ ...d, first_name: e.target.value }))}
                          className="border dark:border-slate-600 rounded px-2 py-1 w-24 dark:bg-slate-800 dark:text-white" placeholder="First" />
                        <input value={editData.last_name} onChange={e => setEditData(d => ({ ...d, last_name: e.target.value }))}
                          className="border dark:border-slate-600 rounded px-2 py-1 w-24 dark:bg-slate-800 dark:text-white" placeholder="Last" />
                      </div>
                    </td>
                    <td className="p-3">
                      <input value={editData.email} onChange={e => setEditData(d => ({ ...d, email: e.target.value }))}
                        className="border dark:border-slate-600 rounded px-2 py-1 w-full dark:bg-slate-800 dark:text-white" placeholder="Email" />
                    </td>
                    <td className="p-3">
                      <select value={editData.grade} onChange={e => setEditData(d => ({ ...d, grade: e.target.value }))}
                        className="border dark:border-slate-600 rounded px-2 py-1 dark:bg-slate-800 dark:text-white">
                        <option value="">--</option>
                        {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </td>
                    <td className="p-3">
                      <select value={editData.dismissal_type} onChange={e => setEditData(d => ({ ...d, dismissal_type: e.target.value }))}
                        className="border dark:border-slate-600 rounded px-2 py-1 dark:bg-slate-800 dark:text-white">
                        <option value="car">Car</option>
                        <option value="bus">Bus</option>
                        <option value="walker">Walker</option>
                        <option value="afterschool">After School</option>
                      </select>
                    </td>
                    <td className="p-3 text-right">
                      <button onClick={saveEdit} className="text-green-600 hover:text-green-800 mr-2"><Save className="w-4 h-4" /></button>
                      <button onClick={() => setEditingId(null)} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ) : (
                  <tr key={student.id} className="hover:bg-gray-50 dark:hover:bg-slate-800">
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(student.id)}
                        onChange={() => toggleSelect(student.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                          {(student.firstName || '?')[0]}{(student.lastName || '?')[0]}
                        </div>
                        <span className="font-medium dark:text-white">{student.firstName} {student.lastName}</span>
                      </div>
                    </td>
                    <td className="p-3 text-gray-500 dark:text-slate-400">{student.email || '—'}</td>
                    <td className="p-3 dark:text-slate-200">{student.grade || '—'}</td>
                    <td className="p-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 capitalize">
                        {student.dismissalType || 'car'}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <button onClick={() => startEdit(student)} className="text-gray-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 mr-2">
                        <Edit className="w-4 h-4" />
                      </button>
                      <button onClick={() => onDelete(student.id)} className="text-gray-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                )
              ))
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t dark:border-slate-700 bg-gray-50 dark:bg-slate-800">
            <span className="text-sm text-gray-500 dark:text-slate-400">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex gap-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1 border dark:border-slate-600 rounded text-sm disabled:opacity-50 hover:bg-white dark:hover:bg-slate-700 dark:text-slate-200">Prev</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button key={p} onClick={() => setPage(p)}
                  className={`px-3 py-1 border dark:border-slate-600 rounded text-sm ${page === p ? 'bg-indigo-600 text-white border-indigo-600 dark:border-indigo-600' : 'hover:bg-white dark:hover:bg-slate-700 dark:text-slate-200'}`}>
                  {p}
                </button>
              ))}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="px-3 py-1 border dark:border-slate-600 rounded text-sm disabled:opacity-50 hover:bg-white dark:hover:bg-slate-700 dark:text-slate-200">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Google Workspace Import Modal */}
      {showWorkspaceModal && (
        <WorkspaceImportModal
          schoolId={schoolId}
          wsOrgUnits={wsOrgUnits}
          wsUsers={wsUsers}
          wsLoading={wsLoading}
          wsSelectedOU={wsSelectedOU}
          wsSelectedUsers={wsSelectedUsers}
          wsGradeMap={wsGradeMap}
          wsCheckedOUs={wsCheckedOUs}
          wsImporting={wsImporting}
          wsStep={wsStep}
          setWsOrgUnits={setWsOrgUnits}
          setWsUsers={setWsUsers}
          setWsLoading={setWsLoading}
          setWsSelectedOU={setWsSelectedOU}
          setWsSelectedUsers={setWsSelectedUsers}
          setWsGradeMap={setWsGradeMap}
          setWsCheckedOUs={setWsCheckedOUs}
          setWsImporting={setWsImporting}
          setWsStep={setWsStep}
          onClose={() => {
            setShowWorkspaceModal(false);
            setWsUsers([]);
            setWsOrgUnits([]);
            setWsSelectedUsers(new Set());
            setWsCheckedOUs(new Set());
            setWsGradeMap({});
          }}
          onRefresh={onRefresh}
        />
      )}

      {/* QR Code Print Modal */}
      {showQrPrint && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-4 border-b dark:border-slate-700 print:hidden">
              <h3 className="text-lg font-bold dark:text-white">QR Codes — Student Linking</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"
                >
                  <Printer className="w-4 h-4" />
                  Print
                </button>
                <button onClick={() => setShowQrPrint(false)} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg dark:text-slate-300">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-6 grid grid-cols-2 md:grid-cols-3 gap-4 print:grid-cols-3">
              {(selectedIds.size > 0 ? students.filter(s => selectedIds.has(s.id)) : students).map(student => (
                <div key={student.id} className="border dark:border-slate-700 rounded-lg p-4 text-center break-inside-avoid">
                  <QRCodeSVG
                    value={`${window.location.origin}/gopilot/link?school=${currentSchool?.slug || ''}&code=${student.student_code}`}
                    size={120}
                    className="mx-auto mb-2"
                  />
                  <p className="font-bold text-sm dark:text-white">{student.firstName} {student.lastName}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    {student.grade ? `Grade ${student.grade}` : ''}{student.grade && student.homeroom_name ? ' • ' : ''}{student.homeroom_name || ''}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-slate-500 mt-1 font-mono">{student.student_code}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WORKSPACE IMPORT MODAL ─────────────────────────────────────────

export function WorkspaceImportModal({
  schoolId, wsOrgUnits, wsUsers, wsLoading, wsSelectedOU, wsSelectedUsers,
  wsGradeMap, wsCheckedOUs, wsImporting, wsStep,
  setWsUsers, setWsLoading, setWsSelectedOU, setWsSelectedUsers,
  setWsGradeMap, setWsCheckedOUs, setWsImporting, setWsStep,
  onClose, onRefresh,
}) {
  // Auto-detect grades when org units load
  useEffect(() => {
    if (wsOrgUnits.length > 0 && Object.keys(wsGradeMap).length === 0) {
      const autoMap = {};
      wsOrgUnits.forEach(ou => {
        const detected = detectGradeFromName(ou.name);
        if (detected) autoMap[ou.orgUnitPath] = detected;
      });
      setWsGradeMap(autoMap);
    }
  }, [wsOrgUnits]);

  const handleBulkImport = async () => {
    const selected = [...wsCheckedOUs].map(path => ({
      orgUnitPath: path,
      grade: wsGradeMap[path] || null,
    }));
    if (selected.length === 0) return;

    setWsImporting(true);
    try {
      const res = await api.post(`/schools/${schoolId}/google/import-org-units`, { orgUnits: selected });
      const details = res.data.details || [];
      const summary = details.map(d => `${d.orgUnitPath}: ${d.imported} new, ${d.updated} updated`).join('\n');
      alert(`Imported ${res.data.imported} new students, updated ${res.data.updated} existing.\n\n${summary}`);
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error(err);
      alert('Failed to import. Make sure your Google account has admin access.');
    }
    setWsImporting(false);
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

  const handleSingleImport = async () => {
    setWsImporting(true);
    try {
      const usersToImport = wsUsers
        .filter(u => wsSelectedUsers.has(u.email))
        .map(u => ({
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          grade: wsGradeMap['_default'] || null,
          orgUnitPath: u.orgUnitPath,
        }));
      const res = await api.post(`/schools/${schoolId}/google/import-users`, { users: usersToImport });
      alert(`Imported ${res.data.imported} new students, updated ${res.data.updated} existing.`);
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error(err);
      alert('Failed to import. Make sure your Google account has admin access.');
    }
    setWsImporting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b dark:border-slate-700">
          <div className="flex items-center gap-2">
            <GoogleLogo className="w-5 h-5" />
            <h3 className="font-semibold text-lg dark:text-white">Import from Google Workspace</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-slate-700 rounded dark:text-slate-300"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {wsLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin text-gray-400 dark:text-slate-500" />
              <span className="ml-2 text-gray-500 dark:text-slate-400">Loading...</span>
            </div>
          ) : wsStep === 'orgunits' ? (
            <div>
              <p className="text-sm text-gray-600 dark:text-slate-300 mb-3">
                Select org units to import, or click the arrow to pick individual users. Grades are auto-detected from names.
              </p>
              <div className="border dark:border-slate-700 rounded-lg divide-y dark:divide-slate-700">
                {wsOrgUnits.map(ou => (
                  <div key={ou.orgUnitPath} className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-slate-800">
                    <input
                      type="checkbox"
                      checked={wsCheckedOUs.has(ou.orgUnitPath)}
                      onChange={e => {
                        const next = new Set(wsCheckedOUs);
                        if (e.target.checked) next.add(ou.orgUnitPath); else next.delete(ou.orgUnitPath);
                        setWsCheckedOUs(next);
                      }}
                      className="rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium dark:text-white">{ou.name}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400">{ou.orgUnitPath}</p>
                    </div>
                    <select
                      value={wsGradeMap[ou.orgUnitPath] || ''}
                      onChange={e => setWsGradeMap(prev => ({ ...prev, [ou.orgUnitPath]: e.target.value }))}
                      className="border dark:border-slate-600 rounded px-2 py-1 text-sm w-24 dark:bg-slate-800 dark:text-white"
                    >
                      <option value="">No grade</option>
                      {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <button
                      onClick={() => handleDrillIn(ou)}
                      className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded text-gray-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400"
                      title="View individual users"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {wsOrgUnits.length === 0 && (
                  <div className="p-4 text-center">
                    <p className="text-sm text-gray-500 dark:text-slate-400 mb-2">No organizational units found.</p>
                    <button
                      onClick={() => handleDrillIn(null)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Browse all domain users instead
                    </button>
                  </div>
                )}
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
                  <label className="text-sm text-gray-600 dark:text-slate-300">Assign grade:</label>
                  <select
                    value={wsGradeMap['_default'] || ''}
                    onChange={e => setWsGradeMap(prev => ({ ...prev, _default: e.target.value }))}
                    className="border dark:border-slate-600 rounded px-2 py-1 text-sm dark:bg-slate-800 dark:text-white"
                  >
                    <option value="">No grade</option>
                    {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
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
                    <span className="text-xs text-gray-400 dark:text-slate-500 shrink-0">{u.orgUnitPath}</span>
                  </label>
                ))}
                {wsUsers.length === 0 && (
                  <p className="text-sm text-gray-500 dark:text-slate-400 py-8 text-center">No users found in this org unit.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {wsStep === 'orgunits' && wsCheckedOUs.size > 0 && (
          <div className="border-t dark:border-slate-700 p-4 flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-slate-300">{wsCheckedOUs.size} org unit{wsCheckedOUs.size !== 1 ? 's' : ''} selected</p>
            <button
              disabled={wsImporting}
              onClick={handleBulkImport}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {wsImporting ? 'Importing...' : `Import All from ${wsCheckedOUs.size} Org Unit${wsCheckedOUs.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}

        {wsStep === 'users' && wsUsers.length > 0 && (
          <div className="border-t dark:border-slate-700 p-4 flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-slate-300">{wsSelectedUsers.size} user{wsSelectedUsers.size !== 1 ? 's' : ''} selected</p>
            <button
              disabled={wsSelectedUsers.size === 0 || wsImporting}
              onClick={handleSingleImport}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {wsImporting ? 'Importing...' : `Import ${wsSelectedUsers.size} Students`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ADD STUDENT FORM ────────────────────────────────────────────────

export function AddStudentForm({ onAdd, onClose }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', grade: '', dismissal_type: 'car', bus_route: '' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) return;
    await onAdd(form);
    setForm({ first_name: '', last_name: '', email: '', grade: '', dismissal_type: 'car', bus_route: '' });
    onClose();
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-4">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">First Name *</label>
          <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
            className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm w-36 dark:bg-slate-800 dark:text-white" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Last Name *</label>
          <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
            className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm w-36 dark:bg-slate-800 dark:text-white" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Email</label>
          <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm w-48 dark:bg-slate-800 dark:text-white" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Grade</label>
          <select value={form.grade} onChange={e => setForm(f => ({ ...f, grade: e.target.value }))}
            className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white">
            <option value="">--</option>
            {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Dismissal</label>
          <select value={form.dismissal_type} onChange={e => setForm(f => ({ ...f, dismissal_type: e.target.value }))}
            className="border dark:border-slate-600 rounded-lg px-3 py-2 text-sm dark:bg-slate-800 dark:text-white">
            <option value="car">Car</option>
            <option value="bus">Bus</option>
            <option value="walker">Walker</option>
            <option value="afterschool">After School</option>
          </select>
        </div>
        <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
          Add
        </button>
        <button type="button" onClick={onClose} className="px-4 py-2 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-slate-200">
          Cancel
        </button>
      </form>
    </div>
  );
}
