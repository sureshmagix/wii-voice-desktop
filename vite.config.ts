import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

const projectRoot = __dirname;

export default defineConfig({
  root: resolve(projectRoot, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(projectRoot, 'dist'),
    emptyOutDir: true
  },
  plugins: [
    react(),
    electron([
      {
        entry: resolve(projectRoot, 'src/main/index.ts'),
        vite: {
          root: projectRoot,
          build: {
            outDir: resolve(projectRoot, 'dist-electron/main'),
            rollupOptions: {
              external: ['bonjour-service', 'ws']
            }
          }
        }
      },
      {
        entry: resolve(projectRoot, 'src/preload/index.ts'),
        vite: {
          root: projectRoot,
          build: {
            outDir: resolve(projectRoot, 'dist-electron/preload')
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@protocol': resolve(projectRoot, 'src/protocol')
    }
  }
});
