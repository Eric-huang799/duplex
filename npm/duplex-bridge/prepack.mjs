/**
 * Copy the bundled bridge next to this package.json before `npm publish`.
 * The bundle is produced in the repo root: `npm run build:bridge`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '..', '..', 'dist-bridge', 'index.cjs')

if (!fs.existsSync(src)) {
  console.error(
    '[duplex-bridge] missing dist-bridge/index.cjs - run `npm run build:bridge` in the repo root first'
  )
  process.exit(1)
}

fs.copyFileSync(src, path.join(here, 'index.cjs'))
console.log('[duplex-bridge] copied dist-bridge/index.cjs -> npm/duplex-bridge/index.cjs')
