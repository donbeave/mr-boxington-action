import {chmod, lstat, mkdir, readdir, realpath} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import path from 'node:path'

export type NativeSnapshotSelection =
  | {kind: 'none'}
  | {kind: 'latest-compatible'}
  | {kind: 'artifact-id'; id: string}

export function nativeSnapshotId(value: string): string | undefined {
  const id = value.trim()
  if (!id) return undefined
  if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n) {
    throw new Error('snapshot-artifact-id must be a positive GitHub artifact service ID')
  }
  return id
}

/** A selector chooses what MBX checks; it never supplies admission or trust. */
export function nativeSnapshotSelection(modeValue: string, artifactIdValue: string): NativeSnapshotSelection {
  const mode = modeValue.trim() || 'none'
  const id = nativeSnapshotId(artifactIdValue)
  if (mode === 'none') {
    if (id) throw new Error('snapshot-artifact-id requires snapshot-selection "artifact-id"')
    return {kind: 'none'}
  }
  if (mode === 'latest-compatible') {
    if (id) throw new Error('snapshot-artifact-id cannot be combined with snapshot-selection "latest-compatible"')
    return {kind: 'latest-compatible'}
  }
  if (mode === 'artifact-id') {
    if (!id) throw new Error('snapshot-artifact-id is required when snapshot-selection is "artifact-id"')
    return {kind: 'artifact-id', id}
  }
  throw new Error('snapshot-selection must be "none", "latest-compatible", or "artifact-id"')
}

/** Artifact IDs select service records only; MBX verifies bytes and provenance. */
export function nativeSnapshotImportArgs(
  selection: NativeSnapshotSelection,
  comparisonState: string
): string[] {
  const args = ['cache', 'import-native']
  if (selection.kind === 'latest-compatible') {
    args.push('--latest-compatible')
  } else if (selection.kind === 'artifact-id') {
    args.push('--github-artifact-id', selection.id)
  } else {
    throw new Error('a native snapshot selection is required')
  }
  if (comparisonState) args.push('--comparison-state', comparisonState)
  args.push('--json')
  return args
}

/** Create a fresh private native store beneath runner temp, never from GITHUB_ENV. */
export async function createNativeSnapshotStore(
  runnerTemp: string
): Promise<{runnerTemp: string; cacheDirectory: string}> {
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error('RUNNER_TEMP must be an absolute directory for native snapshot import')
  }
  const canonicalRoot = await realpath(runnerTemp)
  const rootInfo = await lstat(canonicalRoot)
  if (
    rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
    canonicalRoot !== path.resolve(canonicalRoot) ||
    (typeof process.getuid === 'function' && rootInfo.uid !== process.getuid())
  ) {
    throw new Error('RUNNER_TEMP must resolve to a canonical directory owned by the runner')
  }
  let store = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(canonicalRoot, `velnor-mbx-cache-${randomBytes(16).toString('hex')}`)
    try {
      await mkdir(candidate, {mode: 0o700})
      store = candidate
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (!store) throw new Error('Could not allocate a unique native snapshot cache directory')
  await chmod(store, 0o700)
  const storeInfo = await lstat(store)
  if (
    storeInfo.isSymbolicLink() || !storeInfo.isDirectory() ||
    await realpath(store) !== store || path.dirname(store) !== canonicalRoot ||
    (typeof process.getuid === 'function' && storeInfo.uid !== rootInfo.uid) ||
    (process.platform !== 'win32' && (storeInfo.mode & 0o777) !== 0o700) ||
    (await readdir(store)).length !== 0
  ) {
    throw new Error('Native snapshot store is not a fresh private canonical directory')
  }
  return {runnerTemp: canonicalRoot, cacheDirectory: store}
}
