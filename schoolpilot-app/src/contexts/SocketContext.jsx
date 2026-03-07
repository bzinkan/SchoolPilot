import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const { token } = useAuth();
  const socketRef = useRef(null);
  const subscribersRef = useRef(new Set());

  const notify = () => subscribersRef.current.forEach((cb) => cb());

  useEffect(() => {
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        notify();
      }
      return;
    }

    const socketUrl = Capacitor.isNativePlatform()
      ? 'https://school-pilot.net'
      : window.location.origin;

    const s = io(socketUrl, {
      auth: { token },
      path: '/gopilot-socket',
    });

    s.on('connect', () => console.log('[GoPilot] Socket connected'));
    s.on('disconnect', () => console.log('[GoPilot] Socket disconnected'));

    socketRef.current = s;
    notify();

    // Reconnect when native app resumes from background
    let appListener;
    if (Capacitor.isNativePlatform()) {
      import('@capacitor/app').then(({ App }) => {
        App.addListener('appStateChange', ({ isActive }) => {
          if (isActive && socketRef.current && !socketRef.current.connected) {
            socketRef.current.connect();
          }
        }).then((l) => { appListener = l; });
      });
    }

    return () => {
      s.disconnect();
      appListener?.remove();
    };
  }, [token]);

  const subscribe = (cb) => {
    subscribersRef.current.add(cb);
    return () => subscribersRef.current.delete(cb);
  };
  const getSnapshot = () => socketRef.current;

  const socket = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSocket() {
  return useContext(SocketContext);
}
