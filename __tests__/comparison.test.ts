import {describe, expect, it} from 'vitest'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {prepareComparisonPath} from '../src/comparison.js'

describe('comparison-state path', () => {
  it('accepts a fresh file under RUNNER_TEMP', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-comparison-test-'))
    try {
      const file = path.join(root, 'baseline.json')
      await expect(prepareComparisonPath(file, root)).resolves.toBeUndefined()
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })

  it('rejects paths outside RUNNER_TEMP and existing files or symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-comparison-test-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'mbx-comparison-outside-'))
    try {
      await expect(prepareComparisonPath(path.join(outside, 'baseline.json'), root)).rejects.toThrow(/inside RUNNER_TEMP/)
      const file = path.join(root, 'baseline.json')
      await writeFile(file, '')
      await expect(prepareComparisonPath(file, root)).rejects.toThrow(/fresh path/)
      const link = path.join(root, 'baseline-link.json')
      await symlink(file, link)
      await expect(prepareComparisonPath(link, root)).rejects.toThrow(/fresh path/)
    } finally {
      await rm(root, {recursive: true, force: true})
      await rm(outside, {recursive: true, force: true})
    }
  })

  it('requires an absolute path and an existing parent inside the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-comparison-test-'))
    try {
      await expect(prepareComparisonPath('relative.json', root)).rejects.toThrow(/absolute path/)
      await expect(prepareComparisonPath(path.join(root, 'missing', 'baseline.json'), root))
        .rejects.toThrow()
      await mkdir(path.join(root, 'nested'))
      await expect(prepareComparisonPath(path.join(root, 'nested', 'baseline.json'), root)).resolves.toBeUndefined()
    } finally {
      await rm(root, {recursive: true, force: true})
    }
  })
})
