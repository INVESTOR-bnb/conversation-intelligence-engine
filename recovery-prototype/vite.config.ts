import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built prototype can be opened from any static folder.
export default defineConfig({
  plugins: [react()],
  base: './',
});
