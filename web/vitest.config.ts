import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Deliberately does NOT load vite.config.ts: the TanStack Start plugin does
// route codegen and SSR wiring that component tests neither need nor tolerate.
// React + the '@' alias is the whole story here.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(dirname, './src') } },
  plugins: [viteReact()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
