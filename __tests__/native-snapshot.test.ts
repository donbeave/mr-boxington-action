import {describe, expect, it} from 'vitest'
import {nativeSnapshotId, nativeSnapshotImportArgs, nativeSnapshotSelection} from '../src/native-snapshot.js'

describe('native snapshot selectors', () => {
  it('accepts only canonical positive service IDs and treats them as selectors', () => {
    expect(nativeSnapshotId('42')).toBe('42')
    const selection = nativeSnapshotSelection('artifact-id', '42')
    expect(nativeSnapshotImportArgs(selection as Exclude<typeof selection, {kind: 'none'}>, '/tmp/state')).toEqual([
      'cache', 'import-native', '--github-artifact-id', '42',
      '--comparison-state', '/tmp/state', '--json'
    ])
  })

  it('selects MBX-owned latest-compatible discovery without caller provenance fields', () => {
    const selection = nativeSnapshotSelection('latest-compatible', '')
    expect(selection).toEqual({kind: 'latest-compatible'})
    expect(nativeSnapshotImportArgs(selection, '')).toEqual([
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
    const args = nativeSnapshotImportArgs(nativeSnapshotSelection('artifact-id', '42'), '')
    expect(args).toEqual(['cache', 'import-native', '--github-artifact-id', '42', '--json'])
    expect(args.join(' ')).not.toMatch(/profile|admission|trusted|protected|workflow/)
  })
})
