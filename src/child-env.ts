import path from 'node:path'

const MBX_CHILD_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
  'RUNNER_TEMP',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'GITHUB_WORKSPACE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'CARGO_TARGET_DIR',
  'RUSTC',
  'MBX_CACHE_DIR',
  'MBX_CACHE_LINKS',
  'MBX_GC_AUTO'
] as const

const SNAPSHOT_TRANSPORT_KEYS = [
  'GITHUB_REPOSITORY'
] as const

function systemPath(platform: NodeJS.Platform, source: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    const root = windowsSystemRoot(source)
    return [pathJoinWindows(root, 'System32'), pathJoinWindows(root, 'System32', 'WindowsPowerShell', 'v1.0')]
      .join(';')
  }
  return '/usr/bin:/bin'
}

function windowsSystemRoot(source: NodeJS.ProcessEnv): string {
  const candidate = source.SystemRoot || source.WINDIR || 'C:\\Windows'
  const root = path.win32.resolve(candidate)
  const parsed = path.win32.parse(root)
  if (
    !path.win32.isAbsolute(candidate) ||
    path.win32.normalize(path.win32.dirname(root)).toLowerCase() !==
      path.win32.normalize(parsed.root).toLowerCase() ||
    !['windows', 'winnt'].includes(path.win32.basename(root).toLowerCase())
  ) {
    throw new Error('system archive extraction requires the operating-system Windows directory')
  }
  return root
}

function pathJoinWindows(...parts: string[]): string {
  return parts.join('\\').replace(/\\+/g, '\\')
}

function selectEnvironment(
  keys: readonly string[],
  source: NodeJS.ProcessEnv
): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) selected[key] = value
  }
  return selected
}

/** Environment for ordinary MBX and tool children. Sensitive runner credentials stay in Node. */
export function mbxChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return selectEnvironment(MBX_CHILD_KEYS, source)
}

/**
 * The only environment allowed to carry the snapshot read token. Only the
 * repository selector and fresh action-owned runner-temp paths accompany it.
 * MBX validates workspace roots from its compiled profile and explicit
 * working directory. It receives no PATH, ambient storage roots, proxy, Node options, OIDC request
 * credentials, runner identity, or cache-runtime credentials.
 */
export function snapshotTransportEnvironment(
  token: string,
  cacheDirectory: string,
  runnerTemp: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (!token.trim()) throw new Error('snapshot read token is required for native snapshot import')
  if (!path.isAbsolute(cacheDirectory) || !path.isAbsolute(runnerTemp)) {
    throw new Error('native snapshot cache directory and runner temp must be absolute action-owned paths')
  }
  return {
    ...selectEnvironment(SNAPSHOT_TRANSPORT_KEYS, source),
    RUNNER_TEMP: runnerTemp,
    MBX_CACHE_DIR: cacheDirectory,
    GITHUB_TOKEN: token
  }
}

/** Minimal environment for the system archive tool used by @actions/tool-cache. */
export function archiveExtractionEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const selected: Record<string, string> = {
    PATH: systemPath(platform, source)
  }
  for (const key of ['RUNNER_TEMP', 'TEMP', 'TMP', 'TMPDIR'] as const) {
    if (source[key] !== undefined) selected[key] = source[key]
  }
  if (platform === 'win32') {
    const root = windowsSystemRoot(source)
    selected.SystemRoot = root
    selected.WINDIR = root
    selected.PATHEXT = '.EXE;.COM;.BAT;.CMD'
    selected.COMSPEC = pathJoinWindows(root, 'System32', 'cmd.exe')
  }
  return selected
}

/** Run a toolkit helper that cannot accept an explicit child env under a scrubbed process env. */
export async function withTemporaryProcessEnvironment<T>(
  environment: Record<string, string>,
  operation: () => Promise<T>
): Promise<T> {
  const original = {...process.env}
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  try {
    return await operation()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
  }
}
