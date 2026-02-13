import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Basic Vite configuration enabling React support.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devHost = env.VITE_DEV_SERVER_HOST || 'localhost';

  return {
    plugins: [react()],
    server: {
      port: 5174,
      host: devHost,
    }
  };
});
