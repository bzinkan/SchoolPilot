import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function PassPilotStudents() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/students');
        setStudents(Array.isArray(res.data) ? res.data : res.data.students || []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Students</h1>
      <Card>
        {students.length === 0 ? (
          <p className="py-8 text-center text-slate-500">No students found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Grade</th>
                  <th className="px-3 py-2">Student ID</th>
                </tr>
              </thead>
              <tbody>
                {students.slice(0, 50).map((s) => (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{s.firstName} {s.lastName}</td>
                    <td className="px-3 py-2">{s.gradeLevel || '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{s.studentIdNumber || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
