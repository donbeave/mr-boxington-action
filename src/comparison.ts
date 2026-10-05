import path from 'node:path'
import {access, lstat, realpath} from 'node:fs/promises'
import {constants} from 'node:fs'

export async function prepareComparisonPath(file: string, runnerTemp: string): Promise<void> {
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) throw new Error('comparison-state requires an absolute RUNNER_TEMP')
  const root = await realpath(runnerTemp)
  const parent = await realpath(path.dirname(file))
  const relative = path.relative(root, parent)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('comparison-state must stay inside RUNNER_TEMP')
  }
  await access(parent, constants.W_OK)
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('comparison-state must be a fresh path; preexisting files and symlinks are forbidden')
}

export async function requireComparisonFile(file: string): Promise<void> {
  if (!(await lstat(file)).isFile()) throw new Error('comparison-state must be a regular file, never a symlink')
}

export function cacheTransportUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const failure = error as {code?: string, statusCode?: number, name?: string}
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(failure.code || '') ||
    failure.statusCode === 429 || (typeof failure.statusCode === 'number' && failure.statusCode >= 500) ||
    failure.name === 'CacheReadDeniedError'
}

export function validateComparisonMode(
  file: string,
  strict: boolean,
  backend: string,
  mode: string,
  cacheKey: string,
  restoreKeys: string[],
  cacheKeySuffix = ''
): void {
  if (!file) return
  if (!strict || backend !== 'github' || mode !== 'objects') {
    throw new Error('comparison-state requires mbx-path, expected-version, backend github, and github-cache-mode objects')
  }
  if (!path.isAbsolute(file)) throw new Error('comparison-state must be an absolute path')
  if (!cacheKey) {
    throw new Error('comparison-state requires an explicit cache-key compatibility domain from the workflow generator')
  }
  if (cacheKeySuffix) {
    throw new Error('comparison-state cannot be combined with cache-key-suffix')
  }
  if (cacheKey !== cacheKey.trim() || cacheKey.endsWith('-')) {
    throw new Error('comparison-state cache-key must be a trimmed compatibility base without a trailing separator')
  }
  if (cacheKey.includes(',') || cacheKey.length + 65 > 512) {
    throw new Error('comparison-state cache-key must leave room for its 65-character semantic digest suffix and cannot contain commas')
  }
  if (restoreKeys.length === 0) {
    throw new Error('comparison-state requires explicit restore-keys scoped by the workflow generator')
  }
  if (restoreKeys.length > 9 || restoreKeys.some(key => key.length > 512 || key.includes(','))) {
    throw new Error('comparison-state supports at most nine comma-free restore keys, each no longer than 512 characters')
  }
  if (restoreKeys.some(key => !key.startsWith(`${cacheKey}-`))) {
    throw new Error('comparison-state restore-keys must stay inside the explicit cache-key compatibility domain')
  }
}

export function comparisonExportResult(output: string): {
  useful: boolean
  digest: string
  workspaceUsefulness: {status: 'unavailable', reason: string}
  workspacePersistenceVerified: false
} {
  const result: unknown = JSON.parse(output)
  if (!result || typeof result !== 'object') throw new Error('Invalid mbx comparison export report')
  const report = result as Record<string, unknown>
  const reportKeys = [
    'version', 'budget_refused', 'snapshot_budget_bytes', 'exported', 'actions', 'objects', 'bytes',
    'emitted_bundle_useful_delta', 'workspace_usefulness', 'delta', 'semantic_digest',
    'workspace_comparison', 'workspace_comparison_exclusions', 'workspace_transport_scope',
    'workspace_capture', 'workspace_capture_unavailable_reason', 'workspace_persistence_verified',
    'qualification'
  ].sort()
  const deltaKeys = [
    'new_action_results', 'changed_action_results', 'new_predictions',
    'new_workspace_variants', 'changed_workspace_variants'
  ].sort()
  const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
    const keys = Object.keys(value).sort()
    return keys.length === expected.length && keys.every((key, index) => key === expected[index])
  }
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
  const delta = report.delta
  const workspace = report.workspace_usefulness
  const capture = report.workspace_capture
  const reason = workspace && typeof workspace === 'object'
    ? (workspace as Record<string, unknown>).reason
    : undefined
  const expectedReason: Record<string, string> = {
    captured: 'scheduler_validity_not_proven',
    unavailable_owner_coverage: 'owner_coverage_unavailable',
    unavailable_owner_proof: 'owner_proof_unavailable',
    unavailable_managed_overlap: 'managed_overlap'
  }
  const captureReason = report.workspace_capture_unavailable_reason
  if (report.version !== 2 || report.budget_refused !== false ||
      typeof report.exported !== 'boolean' || typeof report.emitted_bundle_useful_delta !== 'boolean' ||
      typeof report.semantic_digest !== 'string' || !/^[0-9a-f]{64}$/.test(report.semantic_digest) ||
      !exactKeys(report, reportKeys) ||
      !count(report.actions) || !count(report.objects) || !count(report.bytes) ||
      !count(report.snapshot_budget_bytes) ||
      !delta || typeof delta !== 'object' || !exactKeys(delta as Record<string, unknown>, deltaKeys) ||
      !deltaKeys.every(key => count((delta as Record<string, unknown>)[key])) ||
      !workspace || typeof workspace !== 'object' || !exactKeys(workspace as Record<string, unknown>, ['reason', 'status']) ||
      (workspace as Record<string, unknown>).status !== 'unavailable' || typeof capture !== 'string' || reason !== expectedReason[capture] ||
      !['captured', 'unavailable_owner_coverage', 'unavailable_owner_proof', 'unavailable_managed_overlap'].includes(String(capture)) ||
      (capture === 'captured' ? captureReason !== null : typeof captureReason !== 'string') ||
      report.workspace_persistence_verified !== false ||
      report.workspace_comparison !== 'relative_path_type_content_mode_symlink_target' ||
      JSON.stringify(report.workspace_comparison_exclusions) !== JSON.stringify(['effective_build_root/.rustc_info.json']) ||
      report.workspace_transport_scope !== 'recorded_target_and_build_directories' ||
      typeof report.qualification !== 'string' || report.qualification.length === 0) {
    throw new Error('Invalid mbx comparison export report: require exact native v2 schema and unqualified workspace status')
  }
  return {
    useful: report.exported && report.emitted_bundle_useful_delta,
    digest: report.semantic_digest,
    workspaceUsefulness: {status: 'unavailable', reason: reason as string},
    workspacePersistenceVerified: false
  }
}
