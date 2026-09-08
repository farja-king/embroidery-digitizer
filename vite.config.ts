import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this repo at /embroidery-digitizer/, not the domain root,
  // so every asset URL the build emits needs that prefix. Only applies to the
  // production build (`npm run build`) -- `npm run dev` still serves from / locally.
  base: '/embroidery-digitizer/',
})
