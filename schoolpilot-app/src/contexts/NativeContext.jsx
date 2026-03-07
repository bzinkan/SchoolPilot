import { createContext, useContext, useEffect, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';

const NativeContext = createContext(null);

export function NativeProvider({ children }) {
  const isNative = Capacitor.isNativePlatform();
  const platform = Capacitor.getPlatform(); // 'android' | 'ios' | 'web'
  const product = import.meta.env.VITE_APP_PRODUCT || null; // 'gopilot' | 'passpilot' | null

  useEffect(() => {
    if (!isNative) return;

    let cleanup = () => {};

    (async () => {
      // Hide splash screen after app is ready
      const { SplashScreen } = await import('@capacitor/splash-screen');
      SplashScreen.hide();

      // Set status bar style
      if (platform === 'android') {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        StatusBar.setStyle({ style: Style.Dark });
        StatusBar.setBackgroundColor({ color: '#1e3a5f' });
      }

      // Handle Android back button
      const { App } = await import('@capacitor/app');
      const listener = await App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          App.minimizeApp();
        }
      });
      cleanup = () => listener.remove();
    })();

    return () => cleanup();
  }, [isNative, platform]);

  const value = useMemo(() => ({ isNative, platform, product }), [isNative, platform, product]);

  return (
    <NativeContext.Provider value={value}>
      {children}
    </NativeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNative() {
  const ctx = useContext(NativeContext);
  if (!ctx) throw new Error('useNative must be used within NativeProvider');
  return ctx;
}
