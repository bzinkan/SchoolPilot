import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { apiRequest } from '../../../lib/queryClient';
import StudentBrowsingHistory from './StudentBrowsingHistory';

export default function StudentHistoryLookup({ schoolId, viewerId, viewerRole }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const lookup = useInfiniteQuery({
    queryKey: ['classpilot', 'history-students', schoolId, viewerId, viewerRole, search],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ search, limit: '50' });
      if (pageParam) params.set('cursor', pageParam);
      return apiRequest('GET', `/classpilot/students/browsing-history?${params}`, undefined, { signal });
    },
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: Boolean(schoolId && viewerId),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const students = lookup.error ? [] : lookup.data?.pages.flatMap((page) => page.students) || [];
  const status = lookup.error?.response?.status;
  const lookupDenied = status === 401 || status === 403;

  const handleSearch = (event) => {
    event.preventDefault();
    setSelectedStudent(null);
    const nextSearch = searchInput.trim();
    if (nextSearch === search) void lookup.refetch();
    else setSearch(nextSearch);
  };

  return (
    <div className="space-y-4" data-testid="student-history-lookup">
      <p className="text-sm text-muted-foreground">
        Look up recorded browsing by date, even when a student is offline or no class is running.
        {viewerRole === 'teacher' ? ' Only students you taught or supervised within the retention period are listed; history includes only your supervised intervals.' : ''}
      </p>
      <form onSubmit={handleSearch} className="flex items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1 text-sm font-medium">
          <span>Search students</span>
          <Input
            type="search"
            maxLength={150}
            aria-label="Search students for browsing history"
            placeholder="Student name or email"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline">Search</Button>
      </form>

      {lookup.isPending ? (
        <p role="status" className="py-4 text-sm text-muted-foreground">Loading students…</p>
      ) : lookup.error ? (
        <div role="alert" className="space-y-3 rounded-md border p-4 text-sm">
          <p>{lookupDenied
            ? 'Your account is not authorized to look up browsing history.'
            : 'Students could not be loaded. Try again.'}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => lookup.refetch()}>Retry student lookup</Button>
        </div>
      ) : selectedStudent ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div>
              <h3 className="text-base font-semibold">{selectedStudent.name}</h3>
              {selectedStudent.email ? <p className="text-xs text-muted-foreground">{selectedStudent.email}</p> : null}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setSelectedStudent(null)}>Choose another student</Button>
          </div>
          <StudentBrowsingHistory key={selectedStudent.studentId} studentId={selectedStudent.studentId} />
        </div>
      ) : (
        <div className="space-y-3">
          {students.length ? (
            <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="Students with browsing history access">
              {students.map((student) => (
                <li key={student.studentId}>
                  <button
                    type="button"
                    className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setSelectedStudent(student)}
                    data-testid={`button-history-student-${student.studentId}`}
                  >
                    <span className="block font-medium">{student.name}</span>
                    {student.email ? <span className="block text-xs text-muted-foreground">{student.email}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
              {search ? 'No accessible students match this search.' : 'No students are available within your browsing history access and retention period.'}
            </p>
          )}
          {lookup.hasNextPage ? (
            <Button type="button" variant="outline" size="sm" disabled={lookup.isFetchingNextPage} onClick={() => lookup.fetchNextPage()}>
              {lookup.isFetchingNextPage ? 'Loading…' : 'Load more students'}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
