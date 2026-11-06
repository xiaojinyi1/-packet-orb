import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          ui: ['tweakpane', 'gsap', 'howler'],
        },
      },
    },
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      // rapier3d-compat 的 package.json 是 "type": "module" 但 main 指向 .cjs.js，
      // Node/vitest 会把它当 ESM 执行并报 exports is not defined；统一指向 ESM 入口。
      '@dimforge/rapier3d-compat': '@dimforge/rapier3d-compat/rapier.es.js',
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
