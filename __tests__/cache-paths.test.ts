import {afterEach, describe, expect, it} from 'vitest'
import {lstat, mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {prepareObjectCachePath, requireObjectCachePathVector} from '../src/cache-paths.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})))
})

async function missing(file: string): Promise<void> {
  await expect(lstat(file)).rejects.toMatchObject({code: 'ENOENT'})
}

describe('canonical native object-cache payload paths', () => {
  it('rejects empty and relative roots before creating anything', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-path-root-'))
    directories.push(root)
    const relativeRoot = path.relative(process.cwd(), path.join(root, 'relative-cache'))
    await missing(path.join(root, 'relative-cache'))
    await expect(prepareObjectCachePath('', 'bundle', 'directory')).rejects.toThrow(/normalized absolute path/)
    await expect(prepareObjectCachePath(relativeRoot, 'bundle', 'directory')).rejects.toThrow(/normalized absolute path/)
    await missing(path.join(root, 'relative-cache'))
  })

  it('rejects dot traversal before creating the normalized destination', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-dot-root-'))
    directories.push(root)
    const destination = path.join(root, 'cache')
    await missing(destination)
    await expect(prepareObjectCachePath(`${root}${path.sep}dot${path.sep}..${path.sep}cache`, 'bundle', 'directory'))
      .rejects.toThrow(/normalized absolute path/)
    await missing(destination)
  })

  it('returns the direct child of the real cache root as one reusable vector path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-canonical-root-'))
    directories.push(root)
    const alias = path.join(root, 'alias')
    const cache = path.join(root, 'cache')
    await mkdir(cache)
    await symlink(cache, alias)

    const archive = await prepareObjectCachePath(alias, 'github-actions-cache-v1', 'directory')
    const canonicalRoot = await realpath(cache)
    expect(archive).toBe(path.join(canonicalRoot, 'github-actions-cache-v1'))
    expect(await requireObjectCachePathVector([archive], 'github-actions-cache-v1', 'directory')).toBe(archive)
    await expect(requireObjectCachePathVector([archive], 'github-actions-cache-v1', 'directory', true))
      .rejects.toThrow('mbx cache bundle is missing after restore or export')
    await missing(archive)
    await expect(requireObjectCachePathVector([path.relative(process.cwd(), archive)], 'github-actions-cache-v1', 'directory'))
      .rejects.toThrow(/one normalized absolute payload path/)
    await expect(requireObjectCachePathVector([archive, `${archive}-second`], 'github-actions-cache-v1', 'directory'))
      .rejects.toThrow(/one normalized absolute payload path/)
  })

  it('rejects a symlink at the bundle boundary without following it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mbx-bundle-link-'))
    directories.push(root)
    const cache = path.join(root, 'cache')
    const outside = path.join(root, 'outside')
    await mkdir(cache)
    await mkdir(outside)
    await symlink(outside, path.join(cache, 'bundle'))
    await expect(prepareObjectCachePath(cache, 'bundle', 'directory')).rejects.toThrow(/unexpected type or is a symlink/)
    expect((await lstat(outside)).isDirectory()).toBe(true)
  })
})
