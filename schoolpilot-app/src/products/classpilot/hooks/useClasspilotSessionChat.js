import { activityAuthority, activityAuthorityKey, activityAuthorityQuery, activityRequestHeaders, matchesActivityAuthority } from '../lib/dashboardActivity';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';

let nextGeneration = 0;
const DENIED_STATUSES = new Set([401, 403, 404]);
// The WebSocket is the fast path, never the only path: while connected the
// canonical history is still re-read on a modest interval and whenever the tab
// regains focus, so a dropped or filtered live event surfaces without a reload.
export const CHAT_HISTORY_POLL_CONNECTED_MS = 15000;
export const CHAT_HISTORY_POLL_DISCONNECTED_MS = 30000;

function newChatScope(key, schoolId, viewerId, sessionId, authority, contextAuthorityRevision) {
  return {
    key, schoolId, viewerId, sessionId, authority, contextAuthorityRevision, generation: ++nextGeneration,
    sequence: 0, requestSequence: 0, reconnectSequence: 0, appliedRequest: 0, denied: false, historyApplied: false,
    messages: new Map(), deliveries: new Map(), dismissed: new Set(), closedThreads: new Map(), pendingReplies: new Set(),
  };
}

function historyMessage(row, sessionId, schoolId, authority) {
  if (!row?.id || !row.studentId || !matchesActivityAuthority(row, authority)
    || (row.schoolId && row.schoolId !== schoolId)
    || (row.senderType !== 'student' && row.senderType !== 'teacher')) return null;
  return {
    id: row.id, sessionId, studentId: row.studentId, senderType: row.senderType,
    message: row.content, messageType: row.messageType || 'message', timestamp: row.createdAt,
    read: true, status: row.deliveryStatus || 'sent', errorMessage: row.errorMessage, version: 0,
  };
}

function applyHistory(scope, rows, request, dismissedIds) {
  if (request.id < scope.appliedRequest) return;
  scope.appliedRequest = request.id;
  // The first snapshot of a classroom is prior history and reads as seen. A row
  // that later reaches the dashboard only through a re-read (a live event that
  // was dropped or filtered) is new to the teacher and must count as unread.
  const unknownRowsAreRead = !scope.historyApplied;
  scope.historyApplied = true;
  const previous = scope.messages;
  const next = new Map();
  for (const row of rows) {
    const message = historyMessage(row, scope.sessionId, scope.schoolId, scope.authority);
    if (!message || scope.dismissed.has(message.id) || dismissedIds.has(message.id)) continue;
    const existing = previous.get(message.id);
    const closed = scope.closedThreads.get(message.studentId);
    // Closing does not delete canonical history. Known IDs are tombstoned;
    // unknown rows from an older read wait for a fresh read or live event.
    // Browser and server timestamps must never decide whether chat is new.
    const pendingClosedReply = closed && message.senderType === 'teacher'
      && [...scope.pendingReplies].some((reply) => reply.studentId === message.studentId
        && reply.version < closed.sequence);
    if (closed && (!existing || existing.version <= closed.sequence)
      && (request.version < closed.sequence || pendingClosedReply)) {
      continue;
    }
    // A GET is authoritative for older history, but cannot undo a local event
    // that happened after the request began, nor mark an unread event read.
    const merged = existing?.version > request.version
      ? { ...message, ...existing }
      : { ...message, read: existing?.read ?? (unknownRowsAreRead || message.senderType === 'teacher'), version: existing?.version || 0 };
    const delivery = scope.deliveries.get(message.id);
    if (delivery && (delivery.version > request.version || delivery.status === 'delivered')) {
      Object.assign(merged, delivery);
    }
    next.set(message.id, merged);
  }
  for (const [id, message] of previous) {
    if (message.version > request.version && !next.has(id)
      && !scope.dismissed.has(id) && !dismissedIds.has(id)) next.set(id, message);
  }
  scope.messages = next;
}

// History, live events, and teacher replies share one authority-scoped store.
// Student telemetry only supplies display names; it never replays a snapshot.
export function useClasspilotSessionChat({
  schoolId, viewerId, sessionId: teachingSessionId, supervisionContextId, contextAuthorityRevision, enabled, wsAuthenticated, students, dismissedMessageIds,
}) {
  const queryClient = useQueryClient();
  const authority = activityAuthority({ teachingSessionId, supervisionContextId });
  const sessionId = teachingSessionId || supervisionContextId;
  const scopeKey = enabled && schoolId && viewerId && sessionId
    ? JSON.stringify([schoolId, viewerId, activityAuthorityKey(authority), contextAuthorityRevision ?? null]) : null;
  const [scope, setScope] = useState(() => newChatScope(scopeKey, schoolId, viewerId, sessionId, authority, contextAuthorityRevision));
  if (scope.key !== scopeKey) setScope(newChatScope(scopeKey, schoolId, viewerId, sessionId, authority, contextAuthorityRevision));
  const [, setVersion] = useState(0);
  const activeScope = useRef(null);
  const connection = useRef({ authenticated: wsAuthenticated, hasAuthenticated: wsAuthenticated });
  const notify = useCallback(() => setVersion((value) => value + 1), []);
  const queryKey = useMemo(() => (
    ['/api/teacher/messages', scope.schoolId, scope.viewerId, scope.sessionId, scope.generation]
  ), [scope]);
  const currentScope = useCallback(() => {
    const current = activeScope.current;
    return current?.key && !current.denied ? current : null;
  }, []);

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
      scope.messages.clear();
      scope.deliveries.clear();
      scope.dismissed.clear();
      scope.closedThreads.clear();
      scope.pendingReplies.clear();
    };
  }, [queryClient, queryKey, scope]);

  useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const request = { id: ++scope.requestSequence, version: scope.sequence };
      try {
        const data = await apiRequest('GET', `/teacher/messages?${activityAuthorityQuery(scope.authority, true)}`,
          undefined, { signal, headers: activityRequestHeaders(scope.schoolId, scope.contextAuthorityRevision) });
        if (!Array.isArray(data?.messages)) throw new Error('Class chat history is unavailable.');
        if (!signal.aborted && currentScope() === scope) {
          applyHistory(scope, data.messages, request, dismissedMessageIds.current);
          notify();
        }
        return data;
      } catch (error) {
        if (!signal.aborted && currentScope() === scope && DENIED_STATUSES.has(error?.response?.status)) {
          scope.denied = true;
          scope.messages.clear();
          scope.deliveries.clear();
          notify();
        }
        throw error;
      }
    },
    enabled: Boolean(scopeKey && !scope.denied),
    refetchInterval: scope.denied ? false : wsAuthenticated ? CHAT_HISTORY_POLL_CONNECTED_MS : CHAT_HISTORY_POLL_DISCONNECTED_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: (count, error) => !DENIED_STATUSES.has(error?.response?.status) && count < 1,
    gcTime: 0,
  });

  useEffect(() => {
    const previous = connection.current;
    connection.current = {
      authenticated: wsAuthenticated,
      hasAuthenticated: previous.hasAuthenticated || wsAuthenticated,
    };
    if (wsAuthenticated && !previous.authenticated && previous.hasAuthenticated && currentScope() === scope) {
      // A read begun before disconnect may predate messages missed offline.
      // Abort that read, then ensure one read starts after reauthentication.
      const reconnect = ++scope.reconnectSequence;
      void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
        if (currentScope() !== scope || !connection.current.authenticated
          || scope.reconnectSequence !== reconnect) return;
        return queryClient.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false });
      });
    }
  }, [currentScope, queryClient, queryKey, scope, wsAuthenticated]);

  useLayoutEffect(() => {
    if (!scope.denied) return;
    void queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
  }, [queryClient, queryKey, scope, scope.denied]);

  const receiveStudentMessage = useCallback((message) => {
    const current = currentScope();
    if (!current || !matchesActivityAuthority(message, current.authority) || !message.id || !message.studentId
      || current.dismissed.has(message.id) || dismissedMessageIds.current.has(message.id)
      || current.messages.has(message.id)) return false;
    current.messages.set(message.id, { ...message, senderType: 'student', read: false, version: ++current.sequence });
    notify();
    return true;
  }, [currentScope, dismissedMessageIds, notify]);

  const receiveDelivery = useCallback((id, status, errorMessage) => {
    const current = currentScope();
    if (!current || !id || current.dismissed.has(id)) return;
    const previous = current.deliveries.get(id);
    if (previous?.status === 'delivered' && status !== 'delivered') return;
    const delivery = { status, errorMessage, version: ++current.sequence };
    current.deliveries.set(id, delivery);
    const message = current.messages.get(id);
    if (message) current.messages.set(id, { ...message, ...delivery });
    notify();
  }, [currentScope, notify]);

  const beginReply = useCallback((studentId) => {
    const current = currentScope();
    if (!current) return null;
    const request = {
      generation: current.generation, schoolId: current.schoolId, contextAuthorityRevision: current.contextAuthorityRevision,
      sessionId: current.sessionId, authority: current.authority, studentId, version: ++current.sequence,
    };
    current.pendingReplies.add(request);
    return request;
  }, [currentScope]);
  const isCurrentReply = useCallback((request) => {
    const current = currentScope();
    return Boolean(request && current?.generation === request.generation
      && (current.closedThreads.get(request.studentId)?.sequence || 0) < request.version);
  }, [currentScope]);
  const receiveReply = useCallback((request, reply, text) => {
    const current = currentScope();
    if (!request || current?.generation !== request.generation || !reply?.id
      || ((reply.sessionId || reply.supervisionContextId) && !matchesActivityAuthority(reply, current.authority))
      || (reply.schoolId && reply.schoolId !== current.schoolId)
      || (reply.studentId && reply.studentId !== request.studentId)) return false;
    if (!isCurrentReply(request)) {
      // The server may have committed a reply whose POST was still pending
      // when Close Chat was pressed. Its newly known ID stays closed too.
      current.dismissed.add(reply.id);
      current.messages.delete(reply.id);
      current.deliveries.delete(reply.id);
      notify();
      return false;
    }
    const delivery = current.deliveries.get(reply.id);
    current.messages.set(reply.id, {
      id: reply.id, sessionId: current.sessionId, studentId: request.studentId, senderType: 'teacher',
      message: reply.content || text, timestamp: reply.createdAt || new Date().toISOString(),
      status: delivery?.status || reply.deliveryStatus || 'sent',
      errorMessage: delivery ? delivery.errorMessage : reply.errorMessage, version: ++current.sequence,
    });
    notify();
    return true;
  }, [currentScope, isCurrentReply, notify]);
  const finishReply = useCallback((request) => {
    const current = currentScope();
    if (request && current?.generation === request.generation) current.pendingReplies.delete(request);
  }, [currentScope]);

  const markRead = useCallback((id) => {
    const current = currentScope();
    const message = current?.messages.get(id);
    if (!message || message.read) return;
    current.messages.set(id, { ...message, read: true });
    notify();
  }, [currentScope, notify]);
  const dismiss = useCallback((id) => {
    const current = currentScope();
    if (!current) return false;
    current.dismissed.add(id);
    current.messages.delete(id);
    ++current.sequence;
    notify();
    return true;
  }, [currentScope, notify]);
  const closeThread = useCallback((studentId) => {
    const current = currentScope();
    if (!current) return false;
    for (const [id, message] of current.messages) {
      if (message.studentId !== studentId) continue;
      current.dismissed.add(id);
      current.messages.delete(id);
      current.deliveries.delete(id);
    }
    current.closedThreads.set(studentId, { sequence: ++current.sequence });
    notify();
    return true;
  }, [currentScope, notify]);

  const studentLookup = new Map(students.map((student) => [student.studentId || student.id, student]));
  const studentMessages = [];
  const chatReplies = {};
  if (scopeKey && scope.key === scopeKey && !scope.denied) {
    for (const message of scope.messages.values()) {
      if (message.senderType === 'teacher') {
        (chatReplies[message.studentId] ||= []).push(message);
      } else {
        const student = studentLookup.get(message.studentId);
        studentMessages.push({
          ...message,
          studentName: student?.studentName || student?.name
            || [student?.firstName, student?.lastName].filter(Boolean).join(' ').trim()
            || message.studentName || student?.email || message.studentId,
          studentEmail: student?.studentEmail || student?.email || message.studentEmail || '',
        });
      }
    }
  }
  studentMessages.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { generation: scope.generation, studentMessages, chatReplies, receiveStudentMessage, receiveDelivery,
    beginReply, isCurrentReply, receiveReply, finishReply, markRead, dismiss, closeThread };
}
