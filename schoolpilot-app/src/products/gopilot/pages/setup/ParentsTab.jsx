import React, { useState, useEffect } from 'react';
import { Users, Search } from 'lucide-react';
import api from '../../../../shared/utils/api';

export default function ParentsTab({ schoolId }) {
  const [parents, setParents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    async function fetch() {
      setLoading(true);
      try {
        const res = await api.get(`/schools/${schoolId}/parents`);
        if (!cancelled) setParents(res.data);
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    }
    fetch();
    return () => { cancelled = true; };
  }, [schoolId]);

  const filtered = parents.filter(p => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return `${p.first_name} ${p.last_name}`.toLowerCase().includes(term)
      || p.email?.toLowerCase().includes(term)
      || p.car_number?.includes(term);
  });

  if (loading) return <div className="text-center py-12"><p className="text-gray-500">Loading parents...</p></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Parents ({parents.length})</h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search parents or car #..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 border rounded-lg text-sm w-64"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Users className="w-12 h-12 mx-auto mb-2 text-gray-300" />
          <p>{searchTerm ? 'No parents match your search' : 'No parents have joined this school yet'}</p>
          {!searchTerm && (
            <p className="text-sm text-gray-400 mt-2 max-w-md mx-auto">
              Parents will appear here after they download the app, create an account, and link to their children using a student code.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Parent</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Email</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Phone</th>
                <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Car #</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Children</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(parent => (
                <tr key={parent.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium">{parent.first_name} {parent.last_name}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{parent.email}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{parent.phone || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    {parent.car_number ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-bold bg-indigo-100 text-indigo-700">
                        #{parent.car_number}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {parent.children ? parent.children.map(c =>
                      <span key={c.id} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 mr-1 mb-1">
                        {c.first_name} {c.last_name} (Gr {c.grade})
                      </span>
                    ) : <span className="text-gray-400">No linked children</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
