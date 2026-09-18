import { useLayoutEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { activityAuthorityQuery, activityRequestHeaders } from '../lib/dashboardActivity';
import { ChatMessageBubble } from './ChatThread';

const DENIED = new Set([401, 403, 404]);

function transcriptItem(row) {
  return {
    id: row.id,
    message: row.content,
    timestamp: row.createdAt,
    sender: row.senderType === 'teacher' ? 'teacher' : 'student',
    status: row.deliveryStatus,
    errorMessage: row.errorMessage,
    seenAt: row.seenAt,
    deleted: Boolean(row.deletedAt),
  };
}

/**
 * Read-only chat history for one student, scoped to the class or supervision
 * context the viewer actually held. The server route ships with the oversight
 * work; until then, and for anyone without authority, the tab says so instead
 * of guessing.
 */
export default function StudentChatTranscript({ studentId, schoolId, teachingSessionId, supervisionContextId, contextAuthorityRevision }) {
  const authorityQuery = teachingSessionId || supervisionContextId
    ? activityAuthorityQuery({ teachingSessionId, supervisionContextId }) : '';
  const requestScope = JSON.stringify([schoolId, authorityQuery, contextAuthorityRevision, studentId]);
  const requestScopeRef = useRef(requestScope);
  useLayoutEffect(() => {
    requestScopeRef.current = requestScope;
    return () => { requestScopeRef.current = null; };
  }, [requestScope]);
  const transcript = useQuery({
    queryKey: ['/api/classpilot/students/messages', schoolId, studentId, authorityQuery, contextAuthorityRevision],
    queryFn: async ({ signal }) => {
      const scope = requestScope;
      const data = await apiRequest('GET', `/classpilot/students/${encodeURIComponent(studentId)}/messages${authorityQuery ? `?${authorityQuery}` : ''}`,
        undefined, { signal, headers: activityRequestHeaders(schoolId, contextAuthorityRevision) });
      if (requestScopeRef.current !== scope) throw new Error('Transcript scope changed');
      if (!Array.isArray(data?.messages)) throw new Error('Transcript is unavailable');
      return data;
    },
    enabled: Boolean(studentId && schoolId && authorityQuery),
    retry: (count, error) => !DENIED.has(error?.response?.status) && count < 1,
    staleTime: 15_000,
  });

  if (!authorityQuery) {
    return <p className="text-sm text-muted-foreground" data-testid="student-transcript-unavailable">Messages are available while you are teaching or supervising this student.</p>;
  }
  if (transcript.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="student-transcript-loading">Loading messages…</p>;
  }
  if (transcript.isError) {
    const denied = DENIED.has(transcript.error?.response?.status);
    return (
      <div className="space-y-2" data-testid="student-transcript-unavailable">
        <p className="text-sm text-muted-foreground">
          {denied ? 'Messages are unavailable for this class.' : 'Messages could not be loaded.'}
        </p>
        {!denied && <Button size="sm" variant="outline" onClick={() => transcript.refetch()}>Retry</Button>}
      </div>
    );
  }
  const items = transcript.data.messages.map(transcriptItem);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="student-transcript-empty">No messages with this student in this class.</p>;
  }
  return (
    <div className="space-y-1.5" data-testid="student-transcript">
      {items.map((item) => (
        <div key={item.id} className={item.deleted ? 'opacity-50' : undefined} data-testid={item.deleted ? `transcript-deleted-${item.id}` : undefined}>
          <ChatMessageBubble item={item} />
        </div>
      ))}
    </div>
  );
}
