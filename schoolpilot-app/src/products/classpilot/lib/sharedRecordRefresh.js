// Shared records follow current assignments. Private notebooks retain historical access.
export function sharedRecordQuery(query, schoolId, viewerId, importId) {
  const key = query.queryKey;
  return key[0] === 'mydesk-private' && key[1] === schoolId && key[2] === viewerId
    && (['discipline', 'student-information'].includes(key[3])
      || Boolean(importId && key[4] === importId && ['import', 'import-asset', 'import-duplicates'].includes(key[3])));
}

export function subscribeSharedRecordRefresh({ schoolId, viewerId, token, role, onAccessChange, onRefresh,
  browser = window, page = document, Socket = WebSocket }) {
  if (!schoolId || !viewerId) return () => {};
  let disposed = false, socket, heartbeat, reconnect, retryDelay = 1000, authenticatedBefore = false;
  const refresh = () => { if (!disposed) onRefresh(); };
  const visible = () => { if (page.visibilityState === 'visible') refresh(); };
  const connect = () => {
    if (disposed || !token) return;
    const protocol = browser.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new Socket(`${protocol}//${browser.location.host}/ws`);
    const connection = socket;
    connection.addEventListener('open', () => {
      if (disposed || connection !== socket) return;
      connection.send(JSON.stringify({ type: 'auth', userToken: token, userId: viewerId, schoolId,
        role: ['admin', 'school_admin'].includes(role) ? 'school_admin' : 'teacher' }));
      heartbeat = browser.setInterval(() => {
        if (connection.readyState === Socket.OPEN) connection.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    });
    connection.addEventListener('message', event => {
      if (disposed || connection !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'shared-record-access-changed' && message.schoolId === schoolId) onAccessChange();
      if (message.type === 'auth-error') onAccessChange();
      if (message.type === 'auth-success') {
        retryDelay = 1000;
        if (authenticatedBefore) onAccessChange();
        else refresh();
        authenticatedBefore = true;
      }
    });
    connection.addEventListener('close', () => {
      browser.clearInterval(heartbeat);
      if (disposed || connection !== socket) return;
      refresh();
      reconnect = browser.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    });
  };
  browser.addEventListener('focus', refresh);
  browser.addEventListener('online', refresh);
  page.addEventListener('visibilitychange', visible);
  const fallback = browser.setInterval(visible, 30_000);
  connect();
  return () => {
    disposed = true;
    browser.removeEventListener('focus', refresh);
    browser.removeEventListener('online', refresh);
    page.removeEventListener('visibilitychange', visible);
    browser.clearInterval(fallback);
    browser.clearInterval(heartbeat);
    browser.clearTimeout(reconnect);
    socket?.close();
  };
}
