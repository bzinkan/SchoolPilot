import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.schoolpilot.gopilot',
  appName: 'GoPilot',
  webDir: 'dist',
  android: {
    path: 'android-gopilot',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
    },
    Keyboard: {
      resize: 'body',
    },
  },
};

export default config;
