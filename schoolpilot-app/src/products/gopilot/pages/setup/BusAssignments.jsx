import React, { useState, useRef } from 'react';
import { Upload, Bus, Search, CheckCircle2, Download, Pencil, AlertCircle } from 'lucide-react';

export default function BusAssignments({ students, homerooms, onUpdateStudents, onUpdateStudent }) {
  const [subTab, setSubTab] = useState('csv');
  const [toast, setToast] = useState(null);

  // CSV Upload state
  const [csvPreview, setCsvPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Assign by Bus state
  const [busNumber, setBusNumber] = useState('');
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [busFilter, setBusFilter] = useState('all');
  const [busSearch, setBusSearch] = useState('');

  // Individual Edit state
  const [editFilter, setEditFilter] = useState('all');
  const [editSearch, setEditSearch] = useState('');

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // Bus summary data
  const busStudents = students.filter(s => s.dismissalType === 'bus' && s.busRoute);
  const busGroups = {};
  busStudents.forEach(s => {
    if (!busGroups[s.busRoute]) busGroups[s.busRoute] = [];
    busGroups[s.busRoute].push(s);
  });
  const busList = Object.keys(busGroups).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  // Fuzzy name match helper
  const fuzzyMatch = (csvName, studentName) => {
    const a = (csvName || '').toLowerCase().trim();
    const b = (studentName || '').toLowerCase().trim();
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    if (b.startsWith(a) || a.startsWith(b)) return 0.8;
    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) matches++;
    }
    return matches / Math.max(a.length, b.length);
  };

  const findStudentMatch = (firstName, lastName) => {
    let bestMatch = null;
    let bestScore = 0;
    for (const s of students) {
      const fnScore = fuzzyMatch(firstName, s.firstName);
      const lnScore = fuzzyMatch(lastName, s.lastName);
      const score = (fnScore + lnScore) / 2;
      if (score > bestScore && score >= 0.7) {
        bestScore = score;
        bestMatch = s;
      }
    }
    return bestMatch ? { student: bestMatch, score: bestScore } : null;
  };

  // CSV parsing
  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const fnIdx = headers.findIndex(h => h.includes('first'));
    const lnIdx = headers.findIndex(h => h.includes('last'));
    const busIdx = headers.findIndex(h => h.includes('bus'));
    if (fnIdx === -1 || lnIdx === -1 || busIdx === -1) return [];

    return lines.slice(1).filter(l => l.trim()).map(line => {
      const cols = line.split(',').map(c => c.trim());
      const firstName = cols[fnIdx] || '';
      const lastName = cols[lnIdx] || '';
      const bus = cols[busIdx] || '';
      const match = findStudentMatch(firstName, lastName);
      return { firstName, lastName, bus, match };
    });
  };

  const handleCSVFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      setCsvPreview(rows);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
      handleCSVFile(file);
    }
  };

  const downloadTemplate = () => {
    const csv = 'Student First Name,Student Last Name,Bus Number\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bus_assignments_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCSVMatches = async () => {
    if (!csvPreview) return;
    const matched = csvPreview.filter(r => r.match && r.bus);
    const updates = matched.map(r => ({
      id: r.match.student.id,
      dismissal_type: 'bus',
      bus_route: r.bus,
    }));
    if (updates.length === 0) return;
    await onUpdateStudents(updates);
    showToast(`Imported bus assignments for ${updates.length} students`);
    setCsvPreview(null);
  };

  // Assign by Bus handlers
  const toggleStudent = (id) => {
    setSelectedStudents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const assignableStudents = students.filter(s => {
    if (busFilter !== 'all' && s.homeroom !== parseInt(busFilter)) return false;
    if (busSearch) {
      const q = busSearch.toLowerCase();
      if (!(`${s.firstName} ${s.lastName}`.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const assignSelectedToBus = async () => {
    if (!busNumber.trim() || selectedStudents.size === 0) return;
    const updates = [...selectedStudents].map(id => ({
      id,
      dismissal_type: 'bus',
      bus_route: busNumber.trim(),
    }));
    await onUpdateStudents(updates);
    showToast(`Assigned ${updates.length} students to Bus #${busNumber.trim()}`);
    setSelectedStudents(new Set());
  };

  const toggleAll = () => {
    if (selectedStudents.size === assignableStudents.length) {
      setSelectedStudents(new Set());
    } else {
      setSelectedStudents(new Set(assignableStudents.map(s => s.id)));
    }
  };

  // Individual Edit handlers
  const editFiltered = students.filter(s => {
    if (editFilter !== 'all' && s.homeroom !== parseInt(editFilter)) return false;
    if (editSearch) {
      const q = editSearch.toLowerCase();
      if (!(`${s.firstName} ${s.lastName}`.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const handleInlineUpdate = async (studentId, field, value) => {
    const fieldMap = { dismissalType: 'dismissal_type', busRoute: 'bus_route' };
    const apiField = fieldMap[field] || field;
    const payload = { [apiField]: value };
    if (field === 'dismissalType' && value !== 'bus') {
      payload.bus_route = null;
    }
    await onUpdateStudent(studentId, payload);
  };

  const subTabs = [
    { id: 'csv', label: 'CSV Upload', icon: Upload },
    { id: 'assign', label: 'Assign by Bus', icon: Bus },
    { id: 'individual', label: 'Individual Edit', icon: Pencil },
  ];

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
          <CheckCircle2 className="w-4 h-4" /> {toast}
        </div>
      )}

      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Bus Assignments</h2>
        <p className="text-gray-500 dark:text-slate-400 text-sm">Assign students to buses before setting other dismissal types.</p>
      </div>

      {/* Bus Summary Cards */}
      {busList.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {busList.map(busNum => (
            <div key={busNum} className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2 flex items-center gap-2">
              <Bus className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
              <span className="font-semibold text-yellow-800 dark:text-yellow-400">#{busNum}</span>
              <span className="text-sm text-yellow-600 dark:text-yellow-400">{busGroups[busNum].length} riders</span>
            </div>
          ))}
          <div className="bg-gray-50 dark:bg-slate-800 border dark:border-slate-700 rounded-lg px-4 py-2 text-sm text-gray-600 dark:text-slate-300">
            {busStudents.length} total bus riders
          </div>
        </div>
      )}

      {/* Sub-tab Navigation */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700">
        <div className="flex border-b dark:border-slate-700">
          {subTabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setSubTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px ${
                  subTab === tab.id
                    ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                }`}>
                <Icon className="w-4 h-4" /> {tab.label}
              </button>
            );
          })}
        </div>

        <div className="p-4">
          {/* -- CSV Upload Sub-tab -- */}
          {subTab === 'csv' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <button onClick={downloadTemplate}
                  className="flex items-center gap-2 px-3 py-1.5 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-white">
                  <Download className="w-4 h-4" /> Download Template
                </button>
                <span className="text-sm text-gray-500 dark:text-slate-400">Upload a CSV with student names and bus numbers</span>
              </div>

              {!csvPreview ? (
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition ${
                    dragOver ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-500' : 'border-gray-300 dark:border-slate-600 hover:border-gray-400 dark:hover:border-slate-500'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                >
                  <Upload className="w-8 h-8 text-gray-400 dark:text-slate-500 mx-auto mb-2" />
                  <p className="text-gray-600 dark:text-slate-300 font-medium">Drop CSV file here or click to browse</p>
                  <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">Columns: Student First Name, Student Last Name, Bus Number</p>
                  <input ref={fileInputRef} type="file" accept=".csv" className="hidden"
                    onChange={(e) => handleCSVFile(e.target.files[0])} />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-700 dark:text-slate-200">
                      Preview: {csvPreview.filter(r => r.match).length} matched, {csvPreview.filter(r => !r.match).length} unmatched
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setCsvPreview(null)}
                        className="px-3 py-1.5 border dark:border-slate-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-800 dark:text-white">
                        Cancel
                      </button>
                      <button onClick={importCSVMatches}
                        disabled={csvPreview.filter(r => r.match && r.bus).length === 0}
                        className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50">
                        Import {csvPreview.filter(r => r.match && r.bus).length} Students
                      </button>
                    </div>
                  </div>
                  <div className="bg-white dark:bg-slate-900 border dark:border-slate-700 rounded-lg overflow-hidden max-h-80 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-slate-800 border-b dark:border-slate-700">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-slate-300">CSV Name</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-slate-300">Bus #</th>
                          <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-slate-300">Match</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y dark:divide-slate-700">
                        {csvPreview.map((row, i) => (
                          <tr key={i} className={row.match ? 'bg-green-50 dark:bg-green-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'}>
                            <td className="px-3 py-2">{row.firstName} {row.lastName}</td>
                            <td className="px-3 py-2">{row.bus}</td>
                            <td className="px-3 py-2">
                              {row.match ? (
                                <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  {row.match.student.firstName} {row.match.student.lastName}
                                  {row.match.score < 1 && <span className="text-xs text-green-500 dark:text-green-400 ml-1">({Math.round(row.match.score * 100)}%)</span>}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-yellow-700 dark:text-yellow-400">
                                  <AlertCircle className="w-3.5 h-3.5" /> No match
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- Assign by Bus Sub-tab -- */}
          {subTab === 'assign' && (
            <div className="flex gap-4">
              {/* Left: student selection */}
              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-600 dark:text-slate-300">Bus #:</label>
                    <input type="text" value={busNumber} onChange={(e) => setBusNumber(e.target.value)}
                      placeholder="e.g. 42" className="border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg px-3 py-1.5 text-sm w-24" />
                  </div>
                  <select value={busFilter} onChange={(e) => setBusFilter(e.target.value)}
                    className="border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg px-3 py-1.5 text-sm">
                    <option value="all">All homerooms</option>
                    {homerooms.map(hr => (
                      <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                    ))}
                  </select>
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-gray-400 dark:text-slate-500" />
                    <input type="text" value={busSearch} onChange={(e) => setBusSearch(e.target.value)}
                      placeholder="Search students..." className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg pl-8 pr-3 py-1.5 text-sm" />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={assignableStudents.length > 0 && selectedStudents.size === assignableStudents.length}
                      onChange={toggleAll} className="rounded" />
                    Select All ({assignableStudents.length})
                  </label>
                  {selectedStudents.size > 0 && busNumber.trim() && (
                    <button onClick={assignSelectedToBus}
                      className="ml-auto px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">
                      Assign {selectedStudents.size} to Bus #{busNumber.trim()}
                    </button>
                  )}
                </div>

                <div className="border dark:border-slate-700 rounded-lg max-h-80 overflow-y-auto divide-y dark:divide-slate-700">
                  {assignableStudents.map(s => {
                    const hr = homerooms.find(h => h.id === s.homeroom);
                    return (
                      <label key={s.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer">
                        <input type="checkbox" checked={selectedStudents.has(s.id)}
                          onChange={() => toggleStudent(s.id)} className="rounded" />
                        <div className="w-7 h-7 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                          {s.firstName[0]}{s.lastName[0]}
                        </div>
                        <div className="flex-1">
                          <span className="text-sm font-medium dark:text-white">{s.firstName} {s.lastName}</span>
                          {hr && <span className="text-xs text-gray-400 dark:text-slate-500 ml-2">{hr.teacher || hr.name}</span>}
                        </div>
                        {s.dismissalType === 'bus' && s.busRoute && (
                          <span className="text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 px-2 py-0.5 rounded-full">Bus #{s.busRoute}</span>
                        )}
                      </label>
                    );
                  })}
                  {assignableStudents.length === 0 && (
                    <div className="p-4 text-center text-sm text-gray-400 dark:text-slate-500">No students found</div>
                  )}
                </div>
              </div>

              {/* Right: current bus assignments sidebar */}
              <div className="w-64 shrink-0">
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-200 mb-2">Current Buses</h4>
                <div className="border dark:border-slate-700 rounded-lg max-h-96 overflow-y-auto divide-y dark:divide-slate-700">
                  {busList.length === 0 && (
                    <div className="p-3 text-center text-sm text-gray-400 dark:text-slate-500">No bus assignments yet</div>
                  )}
                  {busList.map(busNum => (
                    <details key={busNum} className="group">
                      <summary className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800">
                        <span className="text-sm font-medium dark:text-white flex items-center gap-2">
                          <Bus className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400" /> Bus #{busNum}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-slate-400">{busGroups[busNum].length}</span>
                      </summary>
                      <div className="px-3 pb-2">
                        {busGroups[busNum].map(s => (
                          <div key={s.id} className="text-xs text-gray-600 dark:text-slate-300 py-0.5 pl-6">
                            {s.firstName} {s.lastName}
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* -- Individual Edit Sub-tab -- */}
          {subTab === 'individual' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <select value={editFilter} onChange={(e) => setEditFilter(e.target.value)}
                  className="border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg px-3 py-1.5 text-sm">
                  <option value="all">All homerooms</option>
                  {homerooms.map(hr => (
                    <option key={hr.id} value={hr.id}>{hr.teacher || hr.name} (Gr {hr.grade})</option>
                  ))}
                </select>
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-gray-400 dark:text-slate-500" />
                  <input type="text" value={editSearch} onChange={(e) => setEditSearch(e.target.value)}
                    placeholder="Search students..." className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg pl-8 pr-3 py-1.5 text-sm" />
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border dark:border-slate-700 rounded-lg overflow-hidden">
                <div className="bg-gray-50 dark:bg-slate-800 border-b dark:border-slate-700 px-4 py-2.5">
                  <div className="grid grid-cols-12 gap-4 text-xs font-medium text-gray-500 dark:text-slate-400 uppercase">
                    <div className="col-span-4">Student</div>
                    <div className="col-span-3">Homeroom</div>
                    <div className="col-span-3">Dismissal Type</div>
                    <div className="col-span-2">Bus #</div>
                  </div>
                </div>
                <div className="divide-y dark:divide-slate-700 max-h-96 overflow-y-auto">
                  {editFiltered.map(student => {
                    const hr = homerooms.find(h => h.id === student.homeroom);
                    return (
                      <div key={student.id} className="grid grid-cols-12 gap-4 px-4 py-2.5 items-center">
                        <div className="col-span-4 flex items-center gap-2">
                          <div className="w-7 h-7 bg-indigo-100 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-medium">
                            {(student.firstName || '?')[0]}{(student.lastName || '?')[0]}
                          </div>
                          <span className="text-sm font-medium dark:text-white">{student.firstName} {student.lastName}</span>
                        </div>
                        <div className="col-span-3 text-sm text-gray-500 dark:text-slate-400">
                          {hr ? hr.teacher || hr.name : <span className="text-yellow-600 dark:text-yellow-400 text-xs">Unassigned</span>}
                        </div>
                        <div className="col-span-3">
                          <select value={student.dismissalType}
                            onChange={(e) => handleInlineUpdate(student.id, 'dismissalType', e.target.value)}
                            className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded px-2 py-1 text-sm">
                            <option value="car">Car</option>
                            <option value="bus">Bus</option>
                            <option value="walker">Walker</option>
                            <option value="afterschool">After School</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          {student.dismissalType === 'bus' ? (
                            <input type="text" value={student.busRoute || ''}
                              onChange={(e) => handleInlineUpdate(student.id, 'busRoute', e.target.value)}
                              onBlur={(e) => handleInlineUpdate(student.id, 'busRoute', e.target.value)}
                              placeholder="Bus #" className="w-full border dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded px-2 py-1 text-sm" />
                          ) : (
                            <span className="text-gray-400 dark:text-slate-500 text-sm">&mdash;</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {editFiltered.length === 0 && (
                    <div className="p-4 text-center text-sm text-gray-400 dark:text-slate-500">No students found</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
