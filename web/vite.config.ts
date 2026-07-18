import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  server: { port: 4590 },
  resolve: { alias: { '@': path.resolve(dirname, './src') } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
