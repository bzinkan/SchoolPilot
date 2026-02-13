import { useState, useCallback, useEffect } from 'react';

const TOAST_LIMIT = 1;
const TOAST_AUTO_DISMISS_MS = 5000;

let toastId = 0;
const listeners = new Set();
let toasts = [];

function dispatch(action) {
  switch (action.type) {
    case 'ADD':
      toasts = [action.toast, ...toasts].slice(0, TOAST_LIMIT);
      break;
    case 'DISMISS':
      toasts = toasts.filter((t) => t.id !== action.id);
      break;
    case 'REMOVE_ALL':
      toasts = [];
      break;
    default:
      break;
  }
  listeners.forEach((fn) => fn([...toasts]));
}

export function toast({ title, description, variant = 'default' }) {
  const id = ++toastId;
  dispatch({ type: 'ADD', toast: { id, title, description, variant } });
  setTimeout(() => dispatch({ type: 'DISMISS', id }), TOAST_AUTO_DISMISS_MS);
  return id;
}

export function useToast() {
  const [state, setState] = useState(toasts);

  useEffect(() => {
    listeners.add(setState);
    return () => listeners.delete(setState);
  }, []);

  const dismiss = useCallback((id) => dispatch({ type: 'DISMISS', id }), []);

  return { toasts: state, toast, dismiss };
}
