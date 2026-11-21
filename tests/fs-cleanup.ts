import fs from 'node:fs'
import path from 'node:path'

/**
 * Remove a test directory that may contain read-only Git objects on Windows.
 * Only use this for directories owned by the current test.
 */
export function removeTestDir(dir: string): void {
  const makeWritable = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) makeWritable(full)
      else {
        try {
          fs.chmodSync(full, 0o666)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
  makeWritable(dir)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
