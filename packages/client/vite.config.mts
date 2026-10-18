import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// Shared config for the two Electron targets (main + preload).
const electronBuild = {
  build: {
    rollupOptions: {
      external: ['electron-store', 'adm-zip', 'webdav', 'axios', 'yaml'],
    },
  },
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: electronBuild,
      },
      {
        entry: 'electron/preload.ts',
        vite: electronBuild,
        onstart(options) {
          options.reload()
        },
      },
    ]),
    renderer(),
  ],
})
