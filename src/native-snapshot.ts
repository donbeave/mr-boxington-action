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
