import { defineConfig, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// Shared config for the two Electron targets (main + preload).
const electronBuild = {
  build: {
    rollupOptions: {
      external: ['electron-store', 'adm-zip', 'webdav', 'axios', 'yaml'],
      // vite-plugin-electron sets `build.rollupOptions.platform` (a rolldown-only
      // option) on Vite < 8; Rollup ignores it and prints a warning on every
      // build. Drop just that message so real warnings stay visible.
      onwarn(warning: Rollup.RollupWarning, warn: (w: Rollup.RollupWarning) => void) {
        if (warning.message?.startsWith('Unknown input options: platform')) return
        warn(warning)
      },
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
