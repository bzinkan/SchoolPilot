import axios from 'axios';
import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const baseURL = isNative ? 'https://school-pilot.net/api' : '/api';

const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: !isNative, // cookies for web, JWT-only for native
});

// In-memory token store (never persisted to localStorage)
let _token = null;

export function setApiToken(token) {
  _token = token;
}

// Attach Bearer token from memory on every request
api.interceptors.request.use((config) => {
  if (_token) {
    config.headers.Authorization = `Bearer ${_token}`;
  }
  return config;
});

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
