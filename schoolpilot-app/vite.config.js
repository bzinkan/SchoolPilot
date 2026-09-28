import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-popover',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-label',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-separator',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-progress',
          ],
          'vendor-charts': ['recharts'],
          'vendor-forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
  server: {
    port: 5173,
    fs: {
      // The public HECVAT page imports this single repo doc as raw text.
      allow: [
        searchForWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url))),
        fileURLToPath(new URL('../docs/HECVAT-LITE.md', import.meta.url)),
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/gopilot-socket': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
