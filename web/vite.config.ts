import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command }) => ({
  server: { port: 3000 },
  resolve: { alias: { '@': path.resolve(dirname, './src') } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  // Build only: bundle all deps so dist/server is self-contained for npm
  // packaging. In dev this would force CJS deps (react) through the
  // ESM-only module runner ("module is not defined") — externalize there.
  ssr: command === 'build' ? { noExternal: true } : undefined,
}))
