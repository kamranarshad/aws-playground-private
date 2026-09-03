import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const dirname = path.dirname(fileURLToPath(import.meta.url))

function playgroundApiPlugin(): Plugin {
  return {
    name: 'playground-api',
    configureServer(server) {
      try {
        const bootstrap = require('../server/bootstrap')
        bootstrap.start().catch((err: any) => {
          console.warn(`aws-playground: dev bootstrap error: ${err.message}`)
        })
      } catch (err: any) {
        console.warn(`aws-playground: could not load bootstrap: ${err.message}`)
      }

      server.middlewares.use(async (req, res, next) => {
        try {
          const { handleApiRequest } = require('../server/api/router')
          if (await handleApiRequest(req, res)) {
            return
          }
        } catch (err: any) {
          console.error('aws-playground api router error:', err)
        }
        next()
      })
    },
  }
}

export default defineConfig({
  server: { port: 3000 },
  resolve: { alias: { '@': path.resolve(dirname, './src') } },
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      routeFileIgnorePrefix: '-',
    }),
    tailwindcss(),
    viteReact(),
    playgroundApiPlugin(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@codemirror') || id.includes('@uiw/react-codemirror')) {
            return 'codemirror'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/radix-ui') || id.includes('lucide-react')) {
            return 'ui-vendor'
          }
        },
      },
    },
  },
})
