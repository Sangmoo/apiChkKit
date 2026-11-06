import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// HF Static Space serves build/index.html (see README front matter)
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'build', chunkSizeWarningLimit: 1000 },
})
