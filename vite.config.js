import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

// Sync worker.js -> public/_worker.js so both deploy targets (Workers + Pages)
// run the exact same code. vite copies public/ into dist/ afterwards, so the
// Pages build ships the regenerated copy.
function syncWorker() {
  const banner = '// AUTO-GENERATED from worker.js — do not edit; regenerate with: npm run build\n'
  writeFileSync(`${root}public/_worker.js`, banner + readFileSync(`${root}worker.js`, 'utf8'))
}

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'filo:sync-worker',
      buildStart() { syncWorker() },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/p': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  publicDir: 'public',
})
