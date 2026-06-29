import axios from 'axios';
import { Capacitor } from '@capacitor/core';

const NATIVE_API_BASE_URL = 'https://school-pilot.net/api';
const DIRECT_BACKEND_HOST_PATTERNS = [
  /(^|\.)elb\.amazonaws\.com$/i,
  /^schoolpilot-production/i,
  /schoolpilot-production/i,
];

const isNative = Capacitor.isNativePlatform();

function getBrowserOrigin() {
  if (typeof window === 'undefined' || !window.location?.origin) return '';
  return window.location.origin;
}

export function getApiBaseURL(options = {}) {
  const native = typeof options.isNative === 'boolean' ? options.isNative : Capacitor.isNativePlatform();
  if (native) return NATIVE_API_BASE_URL;

  const origin = options.origin || getBrowserOrigin();
  if (!origin) return '/api';

  try {
    return new URL('/api', origin).toString();
  } catch {
    return '/api';
  }
}

function isDirectBackendHost(hostname) {
  return DIRECT_BACKEND_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isAbsoluteUrl(url) {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url || '');
}

export function resolveApiRequestUrl(url, requestBaseURL = getApiBaseURL(), origin = getBrowserOrigin()) {
  const requestUrl = url || '';
  if (isAbsoluteUrl(requestUrl)) return new URL(requestUrl).toString();

  const base = requestBaseURL || getApiBaseURL({ origin });
  const absoluteBase = new URL(base, origin || 'http://localhost');
  const basePath = absoluteBase.pathname.replace(/\/+$/, '');
  const requestPath = requestUrl.replace(/^\/+/, '');
  return new URL(`${absoluteBase.origin}${basePath || ''}/${requestPath}`).toString();
}

export function assertSafeWebApiRequest(url, requestBaseURL = getApiBaseURL(), origin = getBrowserOrigin()) {
  if (!origin) return true;

  const resolved = new URL(resolveApiRequestUrl(url, requestBaseURL, origin));
  const expectedOrigin = new URL(origin).origin;

  if (resolved.origin !== expectedOrigin || isDirectBackendHost(resolved.hostname)) {
    throw new Error(
      `Blocked cross-origin web API request to ${resolved.origin}; expected same-origin ${expectedOrigin}/api.`
    );
  }

  return true;
}

const baseURL = getApiBaseURL({ isNative });

const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: !isNative, // cookies for web, JWT-only for native
});

// In-memory token store (never persisted to localStorage)
let _token = null;
// CSRF token for cookie-authenticated state-changing requests.
// Fetched lazily from /auth/csrf — JWT-bearer requests skip CSRF entirely.
let _csrfToken = null;
let _csrfFetchPromise = null;

export function setApiToken(token) {
  _token = token;
}

function getActiveSchoolId() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('sp_activeSchoolId');
  } catch {
    return null;
  }
}

const STATE_CHANGING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

async function ensureCsrfToken() {
  if (_csrfToken) return _csrfToken;
  if (_csrfFetchPromise) return _csrfFetchPromise;
  _csrfFetchPromise = axios
    .get(`${baseURL}/auth/csrf`, { withCredentials: !isNative })
    .then((res) => {
      _csrfToken = res.data?.csrfToken || null;
      return _csrfToken;
    })
    .catch(() => null)
    .finally(() => { _csrfFetchPromise = null; });
  return _csrfFetchPromise;
}

// Clear CSRF token on logout — caller should invoke when session ends
export function clearCsrfToken() {
  _csrfToken = null;
}

// Attach Bearer token from memory on every request
api.interceptors.request.use(async (config) => {
  if (_token) {
    config.headers.Authorization = `Bearer ${_token}`;
  }

  if (!isNative) {
    assertSafeWebApiRequest(config.url, config.baseURL || baseURL);
  }

  const activeSchoolId = getActiveSchoolId();
  if (
    activeSchoolId &&
    !config.headers['X-School-Id'] &&
    !config.headers['x-school-id']
  ) {
    config.headers['X-School-Id'] = activeSchoolId;
  }

  // Attach CSRF token on cookie-authenticated state-changing requests.
  // Bearer-token requests skip CSRF (no vector, server middleware skips them too).
  const method = (config.method || 'get').toLowerCase();
  if (!isNative && !_token && STATE_CHANGING_METHODS.has(method)) {
    const url = config.url || '';
    // Skip the csrf endpoint itself and auth bootstrap routes
    const isCsrfBootstrap = url.includes('/auth/csrf') ||
                             url.includes('/auth/login') ||
                             url.includes('/auth/register') ||
                             url.includes('/auth/forgot-password') ||
                             url.includes('/auth/reset-password');
    if (!isCsrfBootstrap) {
      const token = await ensureCsrfToken();
      if (token) config.headers['X-CSRF-Token'] = token;
    }
  }
  return config;
});

// Refresh CSRF token if backend rejects with 403 due to mismatch
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 403 &&
        error.response?.data?.error === 'Invalid or missing CSRF token' &&
        !error.config?._csrfRetried) {
      error.config._csrfRetried = true;
      _csrfToken = null;
      const token = await ensureCsrfToken();
      if (token) {
        error.config.headers['X-CSRF-Token'] = token;
        return api.request(error.config);
      }
    }
    return Promise.reject(error);
  }
);

// Handle 401 → redirect to login (but not for /auth/me which is expected to 401)
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const url = error.config?.url || '';
    const isAuthCheck = url.includes('/auth/me') || url.includes('/auth/login');
    if (error.response?.status === 401 && !isAuthCheck && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
