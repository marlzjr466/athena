import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const developmentNonce = randomBytes(18).toString('base64')

export default defineConfig(({ command }) => {
  const development = command === 'serve'
  const outputRoot = development ? 'out-dev' : 'out'
  const ignoredOutputs = ['**/out/**', '**/out-dev/**', '**/release/**', '**/dist/**', '**/build/**']
  const buildWatch = development ? { chokidar: { ignored: ignoredOutputs } } : undefined
  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: resolve(outputRoot, 'main'), watch: buildWatch, rollupOptions: { input: { main: resolve('electron/main/main.ts'), documentWorker: resolve('electron/main/ai/documentWorker.ts') }, output: { entryFileNames: '[name].js' } } },
  },
  preload: {
    build: {
      outDir: resolve(outputRoot, 'preload'), watch: buildWatch,
      rollupOptions: {
        input: { preload: resolve('electron/preload/preload.ts'), splash: resolve('electron/preload/splash.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    server: { watch: { ignored: ignoredOutputs } },
    html: { cspNonce: command === 'serve' ? developmentNonce : undefined },
    plugins: [react(), tailwindcss(), {
      name: 'athena-development-csp',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace("script-src 'self'", `script-src 'self' 'nonce-${developmentNonce}'`)
      },
    }],
    build: { outDir: resolve(outputRoot, 'renderer'), minify: true, rollupOptions: { input: { index: resolve('index.html'), splash: resolve('splash.html') }, output: { manualChunks: { three: ['three', '@react-three/fiber', '@react-three/drei'] } } } },
  },
  }
})
