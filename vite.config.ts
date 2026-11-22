import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The Cloudflare plugin runs the Worker inside Vite in development and builds both the app and
// the Worker for deployment.
export default defineConfig({
  plugins: [vue(), tailwindcss(), cloudflare()],
})
