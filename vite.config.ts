import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { crx, defineManifest } from '@crxjs/vite-plugin'

const manifest = defineManifest({
  manifest_version: 3,
  name: "Trailhead",
  version: "1.0.0",
  // This tells Chrome where your background logic sits
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // This tells Chrome where your sidebar logic sits
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  permissions: ['sidePanel', 'contextMenus', 'storage', 'activeTab', 'clipboardWrite'],
  host_permissions: ['https://arxiv.org/*'],
  action: {
    default_title: 'Click to open Trailhead',
  },
})

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
})
