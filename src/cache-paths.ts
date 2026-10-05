import path from 'node:path'
import {lstat, mkdir, realpath} from 'node:fs/promises'
import type {BundleForm} from './lib.js'

function safeAbsolutePath(value: string): boolean {
  return Boolean(value) &&
    value === value.trim() &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.split(/[\\/]+/).some(part => part === '.' || part === '..')
}

function assertBundleName(name: string): void {
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('mbx cache bundle name must be one path component')
  }
}

export async function prepareObjectCachePath(
  nativeCacheDirectory: string,
  bundleName: string,
  bundleForm: BundleForm
): Promise<string> {
  assertBundleName(bundleName)
  if (!safeAbsolutePath(nativeCacheDirectory)) {
    throw new Error('mbx cache dir must be a normalized absolute path without dot traversal')
  }
  await mkdir(nativeCacheDirectory, {recursive: true})
  const root = await realpath(nativeCacheDirectory)
  if (!safeAbsolutePath(root)) throw new Error('mbx cache dir did not resolve to a canonical absolute path')
  const archive = path.join(root, bundleName)
  if (path.dirname(archive) !== root || path.relative(root, archive) !== bundleName) {
    throw new Error('mbx cache bundle must stay directly inside its canonical cache directory')
  }
  await verifyExistingBundle(root, archive, bundleName, bundleForm)
  return archive
}

export async function requireObjectCachePathVector(
  paths: string[],
  bundleName: string,
  bundleForm: BundleForm,
  requirePresent = false
): Promise<string> {
  assertBundleName(bundleName)
  const archive = paths[0]
  if (paths.length !== 1 || !archive || !safeAbsolutePath(archive)) {
    throw new Error('mbx object cache requires one normalized absolute payload path')
  }
  const root = path.dirname(archive)
  if (path.basename(archive) !== bundleName || path.relative(root, archive) !== bundleName) {
    throw new Error('mbx object cache payload escaped its canonical cache directory')
  }
  if (await realpath(root) !== root) {
    throw new Error('mbx cache directory changed after restore')
  }
  await verifyExistingBundle(root, archive, bundleName, bundleForm, requirePresent)
  return archive
}

async function verifyExistingBundle(
  root: string,
  archive: string,
  bundleName: string,
  bundleForm: BundleForm,
  requirePresent = false
): Promise<void> {
  try {
    const details = await lstat(archive)
    const expectedType = bundleForm === 'directory' ? details.isDirectory() : details.isFile()
    if (details.isSymbolicLink() || !expectedType) {
      throw new Error('mbx cache bundle path has an unexpected type or is a symlink')
    }
    const resolved = await realpath(archive)
    if (resolved !== archive || path.dirname(resolved) !== root || path.basename(resolved) !== bundleName) {
      throw new Error('mbx cache bundle escaped its canonical cache directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !requirePresent) return
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('mbx cache bundle is missing after restore or export')
    }
    throw error
  }
}
