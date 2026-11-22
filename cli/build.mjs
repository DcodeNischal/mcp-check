// Bundles the command line (cli/bin) and the GitHub Action (action/) into single files with no
// dependencies, so neither needs an npm install to run.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
}
await build({ ...common, entryPoints: ['cli/src/main.ts'], outfile: 'cli/bin/mcp-check.mjs', banner: { js: '#!/usr/bin/env node' } })
await build({ ...common, entryPoints: ['cli/src/action.ts'], outfile: 'action/index.mjs' })
console.log(`built mcp-check ${version}`)
