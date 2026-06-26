import React from 'react';

const ENDPOINT = '/api/monitoring/browser-error';
const DEDUPE_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;
const MAX_MESSAGE = 4000;
const MAX_STACK = 8000;

const recent = new Map();
let windowStartedAt = Date.now();
let sentInWindow = 0;
let installed = false;

function limit(value, max) {
  const str = String(value || '');
  return str.length > max ? `${str.slice(0, Math.max(0, max - 12))}\n[truncated]` : str;
}

function stripUrlQuery(raw) {
  try {
    const url = new URL(raw, window.location.origin);
    return url.pathname || '/';
  } catch {
    return String(raw || '').split(/[?#]/, 1)[0] || undefined;
  }
}

function sanitize(value, max = MAX_MESSAGE) {
  return limit(String(value || ''), max)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => stripUrlQuery(match) || '[url]')
    .replace(/((?:^|[\s"'(])\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]+)\?[^\s"'<>)]*/g, '$1')
    .replace(/\b(token|secret|api[_-]?key|apikey|password|signature|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|code)=([^\s&"'<>)]{3,})/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
    .replace(/\b(?:sk|SG|xox[abprs]?)-[A-Za-z0-9_-]{12,}\b/g, '[secret]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, '[ip]');
}

function browserInfo() {
  const ua = navigator.userAgent || '';
  const edge = ua.match(/Edg\/([0-9.]+)/);
  if (edge) return { browserName: 'Edge', browserVersion: edge[1] };
  const chrome = ua.match(/Chrome\/([0-9.]+)/);
  if (chrome) return { browserName: 'Chrome', browserVersion: chrome[1] };
  const firefox = ua.match(/Firefox\/([0-9.]+)/);
  if (firefox) return { browserName: 'Firefox', browserVersion: firefox[1] };
  const safari = ua.match(/Version\/([0-9.]+).*Safari/);
  if (safari) return { browserName: 'Safari', browserVersion: safari[1] };
  return { browserName: 'Unknown', browserVersion: undefined };
}

function fingerprint(payload) {
  const topFrame = (payload.stack || '').split('\n').find((line) => line.includes('at ')) || '';
  return [
    payload.eventType,
    payload.message,
    topFrame.replace(/:\d+:\d+/g, ':line:col'),
    payload.path,
    payload.component,
  ].join('|');
}

function canSend(payload) {
  const now = Date.now();
  if (now - windowStartedAt >= RATE_WINDOW_MS) {
    windowStartedAt = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= RATE_LIMIT) return false;

  const key = fingerprint(payload);
  const last = recent.get(key) || 0;
  if (now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  sentInWindow++;

  for (const [recentKey, timestamp] of recent.entries()) {
    if (now - timestamp > DEDUPE_MS) recent.delete(recentKey);
  }
  return true;
}

function normalizeReason(reason) {
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack, errorCode: reason.name };
  }
  if (typeof reason === 'string') {
    return { message: reason };
  }
  return { message: 'Unhandled rejection', stack: undefined, errorCode: reason?.name };
}

export function reportRuntimeError(input) {
  if (typeof window === 'undefined') return;

  const payload = {
    source: 'schoolpilot-web',
    eventType: input.eventType,
    message: sanitize(input.message || 'Unknown browser runtime error'),
    stack: input.stack ? sanitize(input.stack, MAX_STACK) : undefined,
    path: stripUrlQuery(input.path || window.location.pathname),
    surface: input.surface ? sanitize(input.surface, 120) : 'web',
    component: input.component ? sanitize(input.component, 160) : undefined,
    errorCode: input.errorCode ? sanitize(input.errorCode, 120) : undefined,
    release: import.meta.env.VITE_APP_VERSION || import.meta.env.VITE_GIT_SHA || undefined,
    ...browserInfo(),
  };

  if (!payload.message || !canSend(payload)) return;

  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
  } catch {
    // Fall back to fetch below.
  }

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body,
    keepalive: true,
  }).catch(() => {});
}

export function installRuntimeTelemetry() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window) {
      const element = target;
      reportRuntimeError({
        eventType: 'resource',
        message: `Resource load failure: ${element.tagName || 'element'}`,
        surface: 'resource',
        component: element.tagName || 'resource',
      });
      return;
    }

    reportRuntimeError({
      eventType: 'error',
      message: event.message,
      stack: event.error?.stack,
      errorCode: event.error?.name,
      surface: 'window',
      component: 'window.onerror',
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const normalized = normalizeReason(event.reason);
    reportRuntimeError({
      eventType: 'unhandledrejection',
      message: normalized.message,
      stack: normalized.stack,
      errorCode: normalized.errorCode,
      surface: 'window',
      component: 'unhandledrejection',
    });
  });
}

export class RuntimeErrorBoundary extends React.Component {
  componentDidCatch(error, info) {
    reportRuntimeError({
      eventType: 'react-boundary',
      message: error?.message || 'React render failure',
      stack: [error?.stack, info?.componentStack].filter(Boolean).join('\n'),
      errorCode: error?.name,
      surface: 'react',
      component: 'RuntimeErrorBoundary',
    });
  }

  render() {
    return this.props.children;
  }
}
