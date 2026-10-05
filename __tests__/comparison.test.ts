import {afterEach, describe, expect, it} from 'vitest'
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {cacheTransportUnavailable, comparisonExportResult, prepareComparisonPath, requireComparisonFile, validateComparisonMode} from '../src/comparison.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true}))) })

function nativeExportReport(exported: boolean, emitted: boolean): Record<string, unknown> {
  return {
    version: 2, budget_refused: false, snapshot_budget_bytes: 100,
    exported, actions: 1, objects: 2, bytes: 3,
    emitted_bundle_useful_delta: emitted,
    workspace_usefulness: {status: 'unavailable', reason: 'scheduler_validity_not_proven'},
    delta: {
      new_action_results: 1, changed_action_results: 0, new_predictions: 0,
      new_workspace_variants: 0, changed_workspace_variants: 0
    },
    semantic_digest: 'a'.repeat(64),
    workspace_comparison: 'relative_path_type_content_mode_symlink_target',
    workspace_comparison_exclusions: ['effective_build_root/.rustc_info.json'],
    workspace_transport_scope: 'recorded_target_and_build_directories',
    workspace_capture: 'captured', workspace_capture_unavailable_reason: null,
    workspace_persistence_verified: false,
    qualification: 'compiler workspace persistence remains unverified'
  }
}

describe('owner comparison report', () => {
  it('accepts only strict objects transport with an absolute baseline', () => {
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'source-bound-key', ['source-bound-key-'])).not.toThrow()
    expect(() => validateComparisonMode('', false, 'local', 'target', '', [])).not.toThrow()
    for (const [strict, backend, mode] of [[false, 'github', 'objects'], [true, 'local', 'objects'], [true, 'github', 'target']] as const) {
      expect(() => validateComparisonMode('/tmp/baseline', strict, backend, mode, 'source-bound-key', ['source-bound-key-'])).toThrow(/requires/)
    }
    expect(() => validateComparisonMode('baseline', true, 'github', 'objects', 'source-bound-key', ['source-bound-key-'])).toThrow(/absolute/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', '', ['source-bound-key-'])).toThrow(/explicit cache-key compatibility domain/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'source-bound-key-', ['source-bound-key--']))
      .toThrow(/without a trailing separator/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'source-bound-key', [])).toThrow(/explicit restore-keys/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'source-bound-key', ['broad-prefix-']))
      .toThrow(/stay inside the explicit cache-key compatibility domain/)
  })
  it('rejects generated cache-key suffixes in comparison mode', () => {
    expect(() => validateComparisonMode(
      '/tmp/baseline', true, 'github', 'objects', 'source-bound-key', ['source-bound-key-'], 'parallel-job'
    )).toThrow(/cannot be combined with cache-key-suffix/)
  })
  it('reserves room for the immutable semantic key and validates restore keys before the task', () => {
    const maxBase = 'a'.repeat(447)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', maxBase, [`${maxBase}-`])).not.toThrow()
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'a'.repeat(448), ['a'.repeat(448) + '-']))
      .toThrow(/65-character semantic digest suffix/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'bad,key', ['bad,key-']))
      .toThrow(/cannot contain commas/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'domain', Array(10).fill('domain-')))
      .toThrow(/at most nine/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'domain', ['domain-,other']))
      .toThrow(/comma-free restore keys/)
    expect(() => validateComparisonMode('/tmp/baseline', true, 'github', 'objects', 'domain', [`domain-${'x'.repeat(506)}`]))
      .toThrow(/comma-free restore keys/)
  })
  it('permits only a fresh path inside the runner temporary directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-path-'))
    directories.push(root)
    const file = path.join(root, 'baseline')
    await expect(prepareComparisonPath(file, root)).resolves.toBeUndefined()
    await expect(prepareComparisonPath(file, '')).rejects.toThrow(/RUNNER_TEMP/)
    await expect(prepareComparisonPath(path.join(path.dirname(root), 'outside'), root)).rejects.toThrow(/inside RUNNER_TEMP/)
    await writeFile(file, '{}')
    await expect(prepareComparisonPath(file, root)).rejects.toThrow(/fresh path/)
    await expect(requireComparisonFile(file)).resolves.toBeUndefined()
    const link = path.join(root, 'symlink')
    await symlink(file, link)
    await expect(prepareComparisonPath(link, root)).rejects.toThrow(/fresh path/)
    await expect(requireComparisonFile(link)).rejects.toThrow(/never a symlink/)
  })
  it('rejects symlink parent escapes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-root-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'mbx-outside-'))
    directories.push(root, outside)
    await symlink(outside, path.join(root, 'escape'))
    await expect(prepareComparisonPath(path.join(root, 'escape', 'baseline'), root)).rejects.toThrow(/inside RUNNER_TEMP/)
  })
  it('classifies only known transport failures as optional', () => {
    for (const error of [{code: 'ECONNRESET'}, {code: 'ENOTFOUND'}, {statusCode: 503}, {statusCode: 429}, {name: 'CacheReadDeniedError'}]) {
      expect(cacheTransportUnavailable(error)).toBe(true)
    }
    for (const error of [new Error('bug'), {code: 'EACCES'}, {statusCode: 400}, {name: 'ValidationError'}, null]) {
      expect(cacheTransportUnavailable(error)).toBe(false)
    }
  })
  it.each([
    {exported: true, emitted: true, useful: true},
    {exported: false, emitted: true, useful: false},
    {exported: true, emitted: false, useful: false},
    {exported: false, emitted: false, useful: false}
  ])('keeps native exported=$exported and emitted useful delta=$emitted separate', ({exported, emitted, useful}) => {
    expect(comparisonExportResult(JSON.stringify(nativeExportReport(exported, emitted))))
      .toEqual({
        useful, digest: 'a'.repeat(64),
        workspaceUsefulness: {status: 'unavailable', reason: 'scheduler_validity_not_proven'},
        workspacePersistenceVerified: false
      })
  })
  it.each([
    {}, {version: 1},
    {...nativeExportReport(true, true), budget_refused: true},
    {...nativeExportReport(true, true), snapshot_budget_bytes: 1.5},
    {...nativeExportReport(true, true), exported: 'true'},
    {...nativeExportReport(true, true), emitted_bundle_useful_delta: 'true'},
    {...nativeExportReport(true, true), semantic_digest: 'bad'},
    {...nativeExportReport(true, true), workspace_usefulness: {status: 'available', reason: 'owner_proof_unavailable'}},
    {...nativeExportReport(true, true), workspace_usefulness: {status: 'unavailable', reason: 'unknown'}},
    {...nativeExportReport(true, true), workspace_persistence_verified: true},
    {...nativeExportReport(true, true), useful_delta: true},
    {...nativeExportReport(true, true), workspace_capture: ['captured']},
    {...nativeExportReport(true, true), qualification: ''},
    {...nativeExportReport(true, true), workspace_capture: 'unavailable_owner_proof'},
    null, []
  ])('fails closed on malformed or qualified report %j', report => {
    expect(() => comparisonExportResult(JSON.stringify(report))).toThrow()
  })

  it('accepts every native unavailable reason without calling it qualified', () => {
    const cases = [
      ['captured', null, 'scheduler_validity_not_proven'],
      ['unavailable_owner_coverage', 'owner proof incomplete', 'owner_coverage_unavailable'],
      ['unavailable_owner_proof', 'owner receipt absent', 'owner_proof_unavailable'],
      ['unavailable_managed_overlap', 'managed root overlap', 'managed_overlap']
    ] as const
    for (const [capture, detail, reason] of cases) {
      const report = nativeExportReport(true, true)
      report.workspace_capture = capture
      report.workspace_capture_unavailable_reason = detail
      report.workspace_usefulness = {status: 'unavailable', reason}
      expect(comparisonExportResult(JSON.stringify(report))).toMatchObject({
        useful: true, workspaceUsefulness: {status: 'unavailable', reason},
        workspacePersistenceVerified: false
      })
    }
  })
})
