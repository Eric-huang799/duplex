/**
 * Candidate-browser registration (feedback FB-001, part A).
 *
 * Registers Duplex with the OS as a *candidate* browser so CLI tools that open
 * pages through the system default browser can land in Duplex once the user
 * picks it. Explicitly NON-intrusive:
 *  - writes only HKCU (per-user), never HKLM;
 *  - never touches the user's default-browser choice (Windows protects it anyway);
 *  - only runs in packaged builds (never registers the dev electron binary);
 *  - the user opts in through the OS Settings page we open for them.
 */
import { app, shell } from 'electron'
import { spawnSync } from 'node:child_process'

const PROGID_URL = 'DuplexURL'
const PROGID_HTML = 'DuplexHTML'
const CAPS = 'Software\\Clients\\StartMenuInternet\\Duplex\\Capabilities'

function reg(args: string[]): void {
  try {
    spawnSync('reg', args, { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* best effort */
  }
}

function regAdd(key: string, valueName: string | null, value: string): void {
  const args = ['add', key]
  if (valueName === null) args.push('/ve')
  else args.push('/v', valueName)
  args.push('/t', 'REG_SZ', '/d', value, '/f')
  reg(args)
}

/** Idempotent; HKCU only. No-op on non-Windows or in dev builds. */
export function registerAsCandidateBrowser(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return
  const exe = process.execPath
  const openCmd = `"${exe}" "%1"`

  // Already registered for this exact executable? nothing to do.
  try {
    const cur = spawnSync('reg', ['query', `HKCU\\Software\\Classes\\${PROGID_URL}\\shell\\open\\command`, '/ve'], {
      windowsHide: true,
      encoding: 'utf8'
    })
    if (cur.status === 0 && String(cur.stdout ?? '').includes(openCmd)) return
  } catch {
    /* fall through and (re)register */
  }

  // URL scheme ProgID
  regAdd(`HKCU\\Software\\Classes\\${PROGID_URL}`, null, 'Duplex URL')
  regAdd(`HKCU\\Software\\Classes\\${PROGID_URL}`, 'URL Protocol', '')
  regAdd(`HKCU\\Software\\Classes\\${PROGID_URL}\\DefaultIcon`, null, `"${exe}",0`)
  regAdd(`HKCU\\Software\\Classes\\${PROGID_URL}\\shell\\open\\command`, null, openCmd)

  // HTML file ProgID (so Duplex can also be chosen for local .html files)
  regAdd(`HKCU\\Software\\Classes\\${PROGID_HTML}`, null, 'Duplex HTML Document')
  regAdd(`HKCU\\Software\\Classes\\${PROGID_HTML}\\DefaultIcon`, null, `"${exe}",0`)
  regAdd(`HKCU\\Software\\Classes\\${PROGID_HTML}\\shell\\open\\command`, null, openCmd)

  // Capabilities (what the Windows "Default apps" page lists)
  regAdd(`HKCU\\${CAPS}`, 'ApplicationName', 'Duplex')
  regAdd(
    `HKCU\\${CAPS}`,
    'ApplicationDescription',
    'Duplex — one browser shared by a human and an AI'
  )
  regAdd(`HKCU\\${CAPS}`, 'StartMenu', 'Duplex')
  regAdd(`HKCU\\${CAPS}`, 'DefaultIcon', `"${exe}",0`)
  regAdd(`HKCU\\${CAPS}\\URLAssociations`, 'http', PROGID_URL)
  regAdd(`HKCU\\${CAPS}\\URLAssociations`, 'https', PROGID_URL)
  regAdd(`HKCU\\${CAPS}\\FileAssociations`, '.html', PROGID_HTML)
  regAdd(`HKCU\\${CAPS}\\FileAssociations`, '.htm', PROGID_HTML)
  regAdd(`HKCU\\Software\\Clients\\StartMenuInternet\\Duplex`, null, 'Duplex')

  // Register the capabilities so the Settings page can list Duplex
  regAdd(
    'HKCU\\Software\\RegisteredApplications',
    'Duplex',
    'Software\\Clients\\StartMenuInternet\\Duplex\\Capabilities'
  )
}

/** Open the OS page where the user can pick Duplex as the default browser. */
export function openDefaultAppsSettings(): void {
  if (process.platform === 'win32') {
    void shell.openExternal('ms-settings:defaultapps')
    return
  }
  if (process.platform === 'darwin') {
    void shell.openExternal('x-apple.systempreferences:com.apple.Desktop')
  }
}
