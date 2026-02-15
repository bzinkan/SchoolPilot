import { useState, useEffect } from 'react';
import Card from '../../../shared/components/Card';
import Spinner from '../../../shared/components/Spinner';
import api from '../../../shared/utils/api';

export default function ClassPilotGroups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/classpilot/groups');
        setGroups(Array.isArray(res.data) ? res.data : res.data.groups || []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner className="mt-12" />;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-foreground">Groups</h1>
      {groups.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-muted-foreground">No groups created yet.</p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.id}>
              <p className="font-medium text-foreground">{g.name}</p>
              <p className="text-sm text-muted-foreground">{g.studentCount || 0} students</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
