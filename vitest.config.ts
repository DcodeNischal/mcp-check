import { defineConfig } from 'vitest/config'

// Unit tests run the shared check code in plain Node, without the Cloudflare plugin
// (vite.config.ts is for the app and Worker build).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
