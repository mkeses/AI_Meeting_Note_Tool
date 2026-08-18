import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // Increase timeout for long audio file transcriptions
        // Large audio files can take several minutes to process
        timeout: 600000, // 10 minutes
        proxyTimeout: 600000, // 10 minutes
      },
    },
  },
});
