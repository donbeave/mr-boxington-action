import {lstat, mkdtemp, realpath, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  createNativeSnapshotStore,
  nativeSnapshotComparisonStateExists,
  nativeSnapshotComparisonStatePath,
  nativeSnapshotId,
  nativeSnapshotImportArgs,
  nativeSnapshotSelection,
  parseNativeSnapshotImportReport
} from '../src/native-snapshot.js'

let tempRoot = ''

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, {recursive: true, force: true})
  tempRoot = ''
})

describe('native snapshot selectors', () => {
  it('accepts only canonical positive service IDs and treats them as selectors', () => {
    expect(nativeSnapshotId('42')).toBe('42')
    const selection = nativeSnapshotSelection('artifact-id', '42')
    expect(nativeSnapshotImportArgs(selection as Exclude<typeof selection, {kind: 'none'}>)).toEqual([
      'cache', 'import-native', '--github-artifact-id', '42', '--json'
    ])
  })

  it('selects MBX-owned latest-compatible discovery without caller provenance fields', () => {
    const selection = nativeSnapshotSelection('latest-compatible', '')
    expect(selection).toEqual({kind: 'latest-compatible'})
    expect(nativeSnapshotImportArgs(selection)).toEqual([
      'cache', 'import-native', '--latest-compatible', '--json'
    ])
  })

  it('keeps no selection cold and rejects incomplete or conflicting selector inputs', () => {
    expect(nativeSnapshotSelection('', '')).toEqual({kind: 'none'})
    expect(() => nativeSnapshotSelection('artifact-id', '')).toThrow(/required/)
    expect(() => nativeSnapshotSelection('none', '42')).toThrow(/requires snapshot-selection/)
    expect(() => nativeSnapshotSelection('latest-compatible', '42')).toThrow(/cannot be combined/)
    expect(() => nativeSnapshotSelection('caller-profile', '')).toThrow(/must be/)
  })

  it.each(['0', '01', '-1', '42/../proof.json', '18446744073709551616'])('rejects untrusted selector %s', id => {
    expect(() => nativeSnapshotSelection('artifact-id', id)).toThrow(/positive GitHub artifact service ID/)
  })

  it('does not accept a caller-supplied profile or admission value', () => {
    const args = nativeSnapshotImportArgs(nativeSnapshotSelection('artifact-id', '42'))
    expect(args).toEqual(['cache', 'import-native', '--github-artifact-id', '42', '--json'])
    expect(args.join(' ')).not.toMatch(/comparison-state|profile|admission|trusted|protected|workflow/)
  })

  it('derives the only comparison path from the action-owned cache store', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mbx-snapshot-test-'))
    const {cacheDirectory} = await createNativeSnapshotStore(tempRoot)
    const state = nativeSnapshotComparisonStatePath(cacheDirectory)
    expect(state).toBe(path.join(cacheDirectory, 'mbx-native-comparison-state-v3.json'))
    await expect(nativeSnapshotComparisonStateExists(cacheDirectory)).resolves.toBe(false)
    await writeFile(state, '{}', {mode: 0o600})
    await expect(nativeSnapshotComparisonStateExists(cacheDirectory)).resolves.toBe(true)
  })

  it('rejects a symlink comparison-state object', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mbx-snapshot-test-'))
    const {cacheDirectory} = await createNativeSnapshotStore(tempRoot)
    const state = nativeSnapshotComparisonStatePath(cacheDirectory)
    const target = path.join(tempRoot, 'forged-state.json')
    await writeFile(target, '{}')
    await symlink(target, state)
    await expect(nativeSnapshotComparisonStateExists(cacheDirectory)).rejects.toThrow(/regular file/)
  })

  it('accepts only exact cold or authenticated import reports and ignores counters', () => {
    expect(parseNativeSnapshotImportReport(JSON.stringify({
      version: 2,
      status: 'cold_miss',
      authenticated: false,
      actions: 0,
      objects: 0,
      bytes: 0,
      comparison_state_recorded: false,
      workspace_restored: false,
      workspace_restore: 'not_attempted'
    }))).toEqual({kind: 'cold-miss'})
    expect(parseNativeSnapshotImportReport(JSON.stringify({
      version: 2,
      status: 'authenticated_imported',
      authenticated: true,
      actions: 0,
      objects: 0,
      bytes: 0,
      comparison_state_recorded: true,
      workspace_restored: true,
      workspace_restore: 'restored'
    }))).toEqual({kind: 'authenticated-imported', workspaceRestored: true})
    expect(parseNativeSnapshotImportReport(JSON.stringify({
      version: 2,
      status: 'authenticated_imported',
      authenticated: false,
      comparison_state_recorded: true,
      workspace_restored: true,
      workspace_restore: 'restored'
    }))).toEqual({kind: 'invalid'})
    expect(parseNativeSnapshotImportReport('{not-json')).toEqual({kind: 'invalid'})
  })

  it('creates a fresh private action-owned cache under canonical RUNNER_TEMP', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'mbx-snapshot-test-'))
    const {runnerTemp, cacheDirectory} = await createNativeSnapshotStore(tempRoot)
    const canonicalRoot = await realpath(tempRoot)
    const info = await lstat(cacheDirectory)
    expect(runnerTemp).toBe(canonicalRoot)
    expect(path.dirname(cacheDirectory)).toBe(canonicalRoot)
    expect(path.basename(cacheDirectory)).toMatch(/^velnor-mbx-cache-[0-9a-f]{32}$/)
    expect(info.isDirectory()).toBe(true)
    expect(info.isSymbolicLink()).toBe(false)
    expect(await readdir(cacheDirectory)).toEqual([])
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
  })

  it('rejects relative or unavailable runner temp roots', async () => {
    await expect(createNativeSnapshotStore('relative')).rejects.toThrow(/absolute directory/)
    await expect(createNativeSnapshotStore(path.join(tmpdir(), 'missing-runner-temp'))).rejects.toThrow()
  })
})
