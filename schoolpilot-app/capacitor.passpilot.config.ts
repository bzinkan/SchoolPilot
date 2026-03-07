import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.schoolpilot.passpilot',
  appName: 'PassPilot',
  webDir: 'dist',
  android: {
    path: 'android-passpilot',
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
