import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { disciplineApi, disciplineKeys, disciplineStatus } from '../lib/discipline';
import { myDeskError } from '../lib/myDeskModel';
import { useDisciplineCapabilities } from '../hooks/useDiscipline';

export default function DisciplineStudentLinks({ access, studentId }) {
  const capability = useDisciplineCapabilities(access);
  const filters = { scope: 'own', studentId, status: 'all', limit: 10 };
  const query = useInfiniteQuery({ queryKey: disciplineKeys.records(access.schoolId, access.viewerId, filters), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => disciplineApi(access.schoolId, signal).search({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: page => page.nextCursor || undefined, enabled: Boolean(studentId && capability.isSuccess && capability.data.canSubmit), retry: false, gcTime: 0 });
  if (!capability.isSuccess || !capability.data.canSubmit) return null;
  if (query.isError) return <section aria-label="Your submitted school records"><p role="alert">{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Retry school records</Button></section>;
  const rows = query.data?.pages.flatMap(page => page.records) || [];
  return <section className="discipline-student-links" aria-label="Your submitted school records"><h2>Your submitted school records</h2><p>These copies are also visible to designated school administrators.</p>
    {query.isPending ? <p role="status">Loading submissions…</p> : !rows.length ? <p>You have not submitted records for this student.</p> : <ul>{rows.map(record => <li key={record.id}><Link to={`/classpilot/discipline-records/${record.id}`}>{record.currentVersion.entryDate} — {record.currentVersion.title || disciplineStatus(record.status)}</Link> <span>{disciplineStatus(record.status)}</span></li>)}</ul>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>More submissions</Button>}
  </section>;
}
