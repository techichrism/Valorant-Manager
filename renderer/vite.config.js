import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// Strip crossorigin attributes from built HTML (breaks Electron file:// protocol)
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    closeBundle() {
      const html = path.resolve(__dirname, 'dist/index.html');
      if (fs.existsSync(html)) {
        fs.writeFileSync(html, fs.readFileSync(html, 'utf-8').replace(/ crossorigin/g, ''));
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), stripCrossorigin()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
