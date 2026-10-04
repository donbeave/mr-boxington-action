import {mkdtemp, mkdir, lstat, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as core from '@actions/core'
import {getCacheVersion} from '../node_modules/@actions/cache/lib/internal/cacheUtils.js'
import {CompressionMethod} from '../node_modules/@actions/cache/lib/internal/constants.js'
import {afterEach, describe, expect, it} from 'vitest'
import {generatedKey, primaryCacheKey} from '../src/lib.js'
import {
  assertIsolatedObjectsActionStore,
  assertObjectsBundleAbsent,
  classifyCacheSaveFailure,
  createObjectsCachePaths,
  importObjectsBundle,
  measureTree,
  pathsFromObjectsCacheRoot,
  reportObjectsResourcePhase,
  saveIsolatedObjectsBundle,
  withIsolatedObjectsPostCleanup,
  validateObjectsBundle,
  validateObjectsCachePaths,
  withBoundedActionOutput
} from '../src/objects-cache.js'

const temporaryRoots: string[] = []

async function makeTemp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mbx-objects-test-'))
  temporaryRoots.push(root)
  return root
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {recursive: true, force: true})))
})

describe('isolated objects cache paths', () => {
  it('creates the exact private siblings beneath canonical RUNNER_TEMP', async () => {
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    const secondPaths = await createObjectsCachePaths(runnerTemp, 'directory')
    expect(paths.runnerTemp).toBe(await realpath(runnerTemp))
    expect(paths.root).toBe(path.join(paths.runnerTemp, path.basename(paths.root)))
    expect(paths.store).toBe(path.join(paths.root, 'store'))
    expect(paths.bundle).toBe(path.join(paths.runnerTemp, 'mbx-github-objects-bundle-v1'))
    expect(secondPaths.root).not.toBe(paths.root)
    expect(secondPaths.bundle).toBe(paths.bundle)
    expect(await pathExists(paths.store)).toBe(true)
    await expect(assertObjectsBundleAbsent(paths)).resolves.toBeUndefined()
    expect(() => assertIsolatedObjectsActionStore(paths, path.join(paths.store, 'actions'))).not.toThrow()
    expect(() => assertIsolatedObjectsActionStore(paths, path.join(runnerTemp, 'shared', 'actions'))).toThrow(
      /outside the private isolated cache store/
    )
  })

  it('keeps the cache archive version shared when primary suffixes differ', async () => {
    const runnerTemp = await makeTemp()
    const first = await createObjectsCachePaths(runnerTemp, 'directory')
    const second = await createObjectsCachePaths(runnerTemp, 'directory')
    const generated = generatedKey('linux', 'x64', 'objects-v1', 'rust-0123456789ab', 'abc123')
    const firstKey = primaryCacheKey('', 'matrix-a', generated)
    const secondKey = primaryCacheKey('', 'matrix-b', generated)
    expect(firstKey).not.toBe(secondKey)
    expect(first.bundle).toBe(second.bundle)
    expect(getCacheVersion([first.bundle], CompressionMethod.Gzip)).toBe(
      getCacheVersion([second.bundle], CompressionMethod.Gzip)
    )
  })

  it('rejects a root outside RUNNER_TEMP, overlapping paths, and symlinked bundle paths', async () => {
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    const outside = path.join(await makeTemp(), 'mbx-github-objects-outside')
    await mkdir(outside)
    await expect(
      pathsFromObjectsCacheRoot(runnerTemp, outside, 'directory')
    ).rejects.toThrow(/exact private RUNNER_TEMP layout/)
    await expect(validateObjectsCachePaths({...paths, store: paths.bundle})).rejects.toThrow(
      /exact private RUNNER_TEMP layout/
    )
    if (process.platform !== 'win32') {
      const outside = path.join(runnerTemp, 'outside')
      await mkdir(outside)
      await symlink(outside, paths.bundle, 'dir')
      await expect(validateObjectsBundle(paths)).rejects.toThrow(/must not be a symlink/)
    }
  })

  it('rejects symlinks inside a restored directory bundle', async () => {
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    await mkdir(paths.bundle)
    await writeFile(path.join(paths.bundle, 'manifest.json'), '{}')
    if (process.platform !== 'win32') {
      await symlink(runnerTemp, path.join(paths.bundle, 'escape'), 'dir')
      await expect(validateObjectsBundle(paths)).rejects.toThrow(/contains a symlink/)
    }
  })

  it('caps wide tree walks while streaming entries and fails closed for bundle validation', async () => {
    const runnerTemp = await makeTemp()
    const tree = path.join(runnerTemp, 'wide-tree')
    await mkdir(tree)
    await Promise.all(
      Array.from({length: 5}, (_, index) => writeFile(path.join(tree, `entry-${index}`), 'x'))
    )
    const measured = await measureTree(tree, false, 3)
    expect(measured.complete).toBe(false)
    expect(measured.entriesScanned).toBeLessThanOrEqual(3)
    await expect(measureTree(tree, true, 3)).rejects.toThrow(/exceeds the 3 entry validation limit/)
  })

  it('measures a symlinked Cargo target through its real directory', async () => {
    if (process.platform === 'win32') return
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    const actualTarget = path.join(runnerTemp, 'actual-target')
    const cargoTarget = path.join(runnerTemp, 'workspace-target')
    await mkdir(actualTarget)
    await writeFile(path.join(actualTarget, 'fingerprint'), 'target-data')
    await symlink(actualTarget, cargoTarget, 'dir')
    const events: string[] = []
    const cargo = await reportObjectsResourcePhase(paths, 'symlink-target-test', cargoTarget, event => {
      events.push(event)
    })
    expect(cargo?.files).toBe(1)
    expect(cargo?.apparentBytes).toBe(String(Buffer.byteLength('target-data')))
    expect(events[0]).toContain('"phase":"symlink-target-test"')
  })

  it('cleans the validated private root after successful and failed post operations', async () => {
    const runnerTemp = await makeTemp()
    const successPaths = await createObjectsCachePaths(runnerTemp, 'directory')
    await mkdir(path.join(successPaths.store, 'actions'), {recursive: true})
    await writeFile(path.join(successPaths.store, 'actions', 'store-object'), 'store')
    await mkdir(successPaths.bundle)
    await writeFile(path.join(successPaths.bundle, 'manifest.json'), '{}')
    const order: string[] = []
    const result = await withIsolatedObjectsPostCleanup(
      successPaths,
      async () => {
        order.push('post-operation')
        expect(await pathExists(successPaths.store)).toBe(true)
        expect(await pathExists(successPaths.bundle)).toBe(true)
        return 'saved'
      },
      () => order.push('warning')
    )
    order.push('post-cleanup')
    expect(result).toBe('saved')
    expect(order).toEqual(['post-operation', 'post-cleanup'])
    expect(await pathExists(successPaths.root)).toBe(false)
    expect(await pathExists(successPaths.store)).toBe(false)
    expect(await pathExists(successPaths.bundle)).toBe(false)

    const failurePaths = await createObjectsCachePaths(runnerTemp, 'directory')
    await mkdir(path.join(failurePaths.store, 'actions'), {recursive: true})
    await mkdir(failurePaths.bundle)
    await writeFile(path.join(failurePaths.bundle, 'partial'), 'export')
    const primaryError = new Error('actions/cache local staging failed')
    await expect(
      withIsolatedObjectsPostCleanup(
        failurePaths,
        async () => {
          throw primaryError
        },
        () => {}
      )
    ).rejects.toBe(primaryError)
    expect(await pathExists(failurePaths.root)).toBe(false)
    expect(await pathExists(failurePaths.bundle)).toBe(false)
  })

  it('preserves the post failure when unsafe paths prevent cleanup', async () => {
    if (process.platform === 'win32') return
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    const outside = path.join(runnerTemp, 'outside')
    await mkdir(outside)
    await symlink(outside, paths.bundle, 'dir')
    const primaryError = new Error('export validation failed')
    const warnings: string[] = []
    await expect(
      withIsolatedObjectsPostCleanup(
        paths,
        async () => {
          throw primaryError
        },
        message => warnings.push(message)
      )
    ).rejects.toBe(primaryError)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Could not remove isolated mbx cache after post failure/)
    expect(await pathExists(paths.root)).toBe(true)
  })

  it('imports a valid bundle and removes it only after import succeeds', async () => {
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    await mkdir(paths.bundle)
    await writeFile(path.join(paths.bundle, 'manifest.json'), '{"objects":1}')
    const order: string[] = []
    await importObjectsBundle(paths, async bundle => {
      order.push('import')
      expect(bundle).toBe(paths.bundle)
      expect(await pathExists(bundle)).toBe(true)
    })
    order.push('removed')
    expect(order).toEqual(['import', 'removed'])
    expect(await pathExists(paths.bundle)).toBe(false)

    await mkdir(paths.bundle)
    await writeFile(path.join(paths.bundle, 'manifest.json'), '{"objects":1}')
    await expect(importObjectsBundle(paths, async () => { throw new Error('corrupt bundle') })).rejects.toThrow(
      /corrupt bundle/
    )
    expect(await pathExists(paths.bundle)).toBe(true)
  })
})

describe('isolated objects bundle save lifecycle', () => {
  async function setup() {
    const runnerTemp = await makeTemp()
    const paths = await createObjectsCachePaths(runnerTemp, 'directory')
    const cargoTarget = path.join(runnerTemp, 'workspace', 'target')
    await mkdir(cargoTarget, {recursive: true})
    await writeFile(path.join(cargoTarget, 'fingerprint'), 'target-data')
    await mkdir(path.join(paths.store, 'actions'), {recursive: true})
    await writeFile(path.join(paths.store, 'actions', 'object'), 'store-data')
    return {paths, cargoTarget}
  }

  it('exports, validates, removes the isolated store, then saves only the external bundle', async () => {
    const {paths, cargoTarget} = await setup()
    const order: string[] = []
    const events: string[] = []
    const originalMode = process.env.ACTIONS_CACHE_SERVICE_V2
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    try {
      const result = await saveIsolatedObjectsBundle({
        paths,
        primaryKey: 'generated-key',
        saveEligible: true,
        exactHit: false,
        cargoTarget,
        exportBundle: async bundle => {
          order.push('export')
          expect(bundle).toBe(paths.bundle)
          expect(await pathExists(bundle)).toBe(false)
          await mkdir(bundle)
          await writeFile(path.join(bundle, 'manifest.json'), '{"objects":1}')
          return {exitCode: 0, output: ''}
        },
        isEmptyExport: output => /no completed builds/i.test(output),
        saveCache: async (cachePaths, key) => {
          order.push('save')
          expect(key).toBe('generated-key')
          expect(cachePaths).toEqual([paths.bundle])
          expect(await pathExists(paths.store)).toBe(false)
          core.info('Cache saved successfully')
          return 17
        },
        emit: message => events.push(message),
        warn: message => events.push(`warning: ${message}`)
      })
      expect(result).toBe('saved')
      expect(order).toEqual(['export', 'save'])
      expect(await pathExists(paths.bundle)).toBe(false)
      expect(await pathExists(paths.store)).toBe(false)
      expect(events.some(event => event.includes('after-build-before-export'))).toBe(true)
      expect(events.some(event => event.includes('after-bundle-export'))).toBe(true)
      expect(events.some(event => event.includes('after-store-removal'))).toBe(true)
      expect(events.some(event => event.includes('actions-cache-save'))).toBe(true)
      expect(events.some(event => event.includes('after-cache-save'))).toBe(true)
      expect(events.some(event => event.includes('bundleApparentBytes'))).toBe(true)
      expect(events.some(event => event.includes('not instantaneous peak pressure'))).toBe(true)
      expect(events.some(event => event.includes('maxObservedIntervalMs'))).toBe(true)
    } finally {
      if (originalMode === undefined) delete process.env.ACTIONS_CACHE_SERVICE_V2
      else process.env.ACTIONS_CACHE_SERVICE_V2 = originalMode
    }
  })

  it('does not save an empty export or remove the live store', async () => {
    const {paths, cargoTarget} = await setup()
    let saveCalls = 0
    const result = await saveIsolatedObjectsBundle({
      paths,
      primaryKey: 'generated-key',
      saveEligible: true,
      exactHit: false,
      cargoTarget,
      exportBundle: async () => ({exitCode: 1, output: 'no completed builds for this group'}),
      isEmptyExport: output => /no completed builds/i.test(output),
      saveCache: async () => {
        saveCalls++
        return 1
      },
      emit: () => {},
      warn: () => {}
    })
    expect(result).toBe('empty')
    expect(saveCalls).toBe(0)
    expect(await pathExists(paths.store)).toBe(true)
  })

  it('fails on export errors and leaves the isolated store intact', async () => {
    const {paths, cargoTarget} = await setup()
    let saveCalls = 0
    await expect(
      saveIsolatedObjectsBundle({
        paths,
        primaryKey: 'generated-key',
        saveEligible: true,
        exactHit: false,
        cargoTarget,
        exportBundle: async () => ({exitCode: 2, output: 'corrupt receipt'}),
        isEmptyExport: () => false,
        saveCache: async () => {
          saveCalls++
          return 1
        },
        emit: () => {},
        warn: () => {}
      })
    ).rejects.toThrow(/export exited with code 2/)
    expect(saveCalls).toBe(0)
    expect(await pathExists(paths.store)).toBe(true)
  })

  it('warns and continues on the cache service reservation result', async () => {
    const {paths, cargoTarget} = await setup()
    const warnings: string[] = []
    const result = await saveIsolatedObjectsBundle({
      paths,
      primaryKey: 'generated-key',
      saveEligible: true,
      exactHit: false,
      cargoTarget,
      exportBundle: async bundle => {
        await mkdir(bundle)
        await writeFile(path.join(bundle, 'manifest.json'), '{}')
        return {exitCode: 0, output: ''}
      },
      isEmptyExport: () => false,
      saveCache: async () => {
        // @actions/cache 6.2.0 logs ReserveCacheError through core.info. This
        // exercises the exact plain stdout bytes captured around saveCache.
        core.info(
          'Failed to save: Unable to reserve cache with key generated-key, another job may be creating this cache.'
        )
        return -1
      },
      emit: () => {},
      warn: message => warnings.push(message)
    })
    expect(result).toBe('save-unavailable')
    expect(warnings).toEqual(['GitHub cache save skipped after classified service-reservation'])
    expect(await pathExists(paths.store)).toBe(false)
    expect(await pathExists(paths.bundle)).toBe(false)
  })

  it('fails on ENOSPC from local actions/cache staging', async () => {
    const {paths, cargoTarget} = await setup()
    await expect(
      saveIsolatedObjectsBundle({
        paths,
        primaryKey: 'generated-key',
        saveEligible: true,
        exactHit: false,
        cargoTarget,
        exportBundle: async bundle => {
          await mkdir(bundle)
          await writeFile(path.join(bundle, 'manifest.json'), '{}')
          return {exitCode: 0, output: ''}
        },
        isEmptyExport: () => false,
        saveCache: async () => {
          core.warning('Failed to save: tar failed: No space left on device (os error 28)')
          return -1
        },
        emit: () => {},
        warn: () => {}
      })
    ).rejects.toThrow(/runner storage is full/)
    expect(await pathExists(paths.store)).toBe(false)
    expect(await pathExists(paths.bundle)).toBe(true)
  })

  it.each([
    ['ineligible policy', false, false, 'ineligible'],
    ['exact cache hit', true, true, 'exact-hit']
  ] as const)('preserves %s by skipping export and save', async (_name, saveEligible, exactHit, expected) => {
    const {paths, cargoTarget} = await setup()
    let exportCalls = 0
    let saveCalls = 0
    const result = await saveIsolatedObjectsBundle({
      paths,
      primaryKey: 'generated-key',
      saveEligible,
      exactHit,
      cargoTarget,
      exportBundle: async () => {
        exportCalls++
        return {exitCode: 0, output: ''}
      },
      isEmptyExport: () => false,
      saveCache: async () => {
        saveCalls++
        return 1
      },
      emit: () => {},
      warn: () => {}
    })
    expect(result).toBe(expected)
    expect(exportCalls).toBe(0)
    expect(saveCalls).toBe(0)
    expect(await pathExists(paths.store)).toBe(true)
  })

  it('fails closed for unknown save results and ENOSPC, but warns on terminal transport failures', async () => {
    const captureWarning = async (message: string) =>
      (await withBoundedActionOutput(async () => core.warning(message))).output
    const captureError = async (message: string) =>
      (await withBoundedActionOutput(async () => core.error(message))).output
    const v1CommitFailure = await captureWarning(
      'Failed to save: commitCache failed: Cache service responded with 503'
    )
    expect(v1CommitFailure).toBe(
      '::warning::Failed to save: commitCache failed: Cache service responded with 503\n'
    )
    expect(classifyCacheSaveFailure(v1CommitFailure)).toBe('service-5xx')

    const v2FinalizeFailure = await captureWarning(
      'Failed to save: Failed to FinalizeCacheEntryUpload: Failed to make request after 5 attempts: Failed request: (503) Service Unavailable'
    )
    expect(v2FinalizeFailure).toBe(
      '::warning::Failed to save: Failed to FinalizeCacheEntryUpload: Failed to make request after 5 attempts: Failed request: (503) Service Unavailable\n'
    )
    expect(classifyCacheSaveFailure(v2FinalizeFailure)).toBe('service-5xx')

    const v2FinalizeHttpError = await captureError(
      'Failed to save: Failed to FinalizeCacheEntryUpload: Failed to make request after 5 attempts: Failed request: (503) Service Unavailable'
    )
    expect(v2FinalizeHttpError).toBe(
      '::error::Failed to save: Failed to FinalizeCacheEntryUpload: Failed to make request after 5 attempts: Failed request: (503) Service Unavailable\n'
    )
    expect(classifyCacheSaveFailure(v2FinalizeHttpError)).toBe('service-5xx')

    const uploadStatusFailure = (
      await withBoundedActionOutput(async () => {
        core.warning(
          'uploadCacheArchiveSDK: internal error uploading cache archive: uploadCacheArchiveSDK: upload failed with status code 503'
        )
        core.warning('Failed to save: uploadCacheArchiveSDK: upload failed with status code 503')
      })
    ).output
    expect(uploadStatusFailure).toBe(
      '::warning::uploadCacheArchiveSDK: internal error uploading cache archive: uploadCacheArchiveSDK: upload failed with status code 503\n' +
        '::warning::Failed to save: uploadCacheArchiveSDK: upload failed with status code 503\n'
    )
    expect(classifyCacheSaveFailure(uploadStatusFailure)).toBe('service-5xx')
    const uploadStatusAttemptOnly = await captureWarning(
      'uploadCacheArchiveSDK: internal error uploading cache archive: uploadCacheArchiveSDK: upload failed with status code 503'
    )
    expect(classifyCacheSaveFailure(uploadStatusAttemptOnly)).toBe('unknown')

    const uploadStatusHttpError = await captureError(
      'Failed to save: uploadCacheArchiveSDK: upload failed with status code 503'
    )
    expect(classifyCacheSaveFailure(uploadStatusHttpError)).toBe('service-5xx')

    const v2FinalizeTransport = await captureWarning(
      'Failed to save: Failed to FinalizeCacheEntryUpload: Unable to make request: ETIMEDOUT\n' +
        'If you are using self-hosted runners, please make sure your runner has access to all GitHub endpoints: https://docs.github.com/en/actions/hosting-your-own-runners/managing-your-own-runners#communication-between-self-hosted-runners-and-github'
    )
    expect(v2FinalizeTransport).toContain(
      '::warning::Failed to save: Failed to FinalizeCacheEntryUpload: Unable to make request: ETIMEDOUT%0A'
    )
    expect(classifyCacheSaveFailure(v2FinalizeTransport)).toBe('network-transport')

    const uploadTransport = (
      await withBoundedActionOutput(async () => {
        core.warning(
          'uploadCacheArchiveSDK: internal error uploading cache archive: RestError: connect ETIMEDOUT 10.0.0.1:443'
        )
        core.warning('Failed to save: RestError: connect ETIMEDOUT 10.0.0.1:443')
      })
    ).output
    expect(uploadTransport).toContain(
      '::warning::uploadCacheArchiveSDK: internal error uploading cache archive: RestError: connect ETIMEDOUT 10.0.0.1:443\n'
    )
    expect(uploadTransport).toContain(
      '::warning::Failed to save: RestError: connect ETIMEDOUT 10.0.0.1:443\n'
    )
    expect(classifyCacheSaveFailure(uploadTransport)).toBe('network-transport')
    const uploadTransportHttpError = await captureError(
      'Failed to save: RestError: connect ETIMEDOUT 10.0.0.1:443'
    )
    expect(classifyCacheSaveFailure(uploadTransportHttpError)).toBe('network-transport')
    const uploadTransportAttemptOnly = await captureWarning(
      'uploadCacheArchiveSDK: internal error uploading cache archive: RestError: connect ETIMEDOUT 10.0.0.1:443'
    )
    expect(classifyCacheSaveFailure(uploadTransportAttemptOnly)).toBe('unknown')

    const v2Retry = (
      await withBoundedActionOutput(async () =>
        core.info(
          'Attempt 1 of 5 failed with error: Failed request: (503) Service Unavailable. Retrying request in 3456 ms...'
        )
      )
    ).output
    expect(classifyCacheSaveFailure(v2Retry)).toBe('unknown')
    expect(
      classifyCacheSaveFailure(
        'Failed to save: Unable to reserve cache with key key, another job may be creating this cache.\n'
      )
    ).toBe('service-reservation')
    expect(
      classifyCacheSaveFailure(
        'Failed to save: Unable to reserve cache with key key, another job may be creating this cache. More details: already reserved\n'
      )
    ).toBe('service-reservation')
    expect(classifyCacheSaveFailure('::warning::Failed to save: tar failed: ENOSPC')).toBe(
      'local-storage'
    )
    expect(
      classifyCacheSaveFailure(
        '::warning::uploadCacheArchiveSDK: internal error uploading cache archive: write failed: ENOSPC\n' +
          '::warning::Failed to save: uploadCacheArchiveSDK: internal error uploading cache archive: write failed: ENOSPC\n'
      )
    ).toBe('local-storage')
    expect(
      classifyCacheSaveFailure(
        'Failed to save: Unable to reserve cache with key X, another job may be creating this cache\n'
      )
    ).toBe('unknown')
    const policyDenial = await captureWarning(
      'Failed to save: Unable to reserve cache with key key. More details: cache write denied: read only'
    )
    expect(classifyCacheSaveFailure(policyDenial)).toBe('unknown')
  })

  it('accepts V2 save IDs only with the V2 service and fails closed on V1 reservation IDs', async () => {
    const {paths, cargoTarget} = await setup()
    const originalV2 = process.env.ACTIONS_CACHE_SERVICE_V2
    const originalServer = process.env.GITHUB_SERVER_URL
    process.env.ACTIONS_CACHE_SERVICE_V2 = 'true'
    process.env.GITHUB_SERVER_URL = 'https://github.com'
    try {
      const result = await saveIsolatedObjectsBundle({
        paths,
        primaryKey: 'generated-key',
        saveEligible: true,
        exactHit: false,
        cargoTarget,
        exportBundle: async bundle => {
          await mkdir(bundle)
          await writeFile(path.join(bundle, 'manifest.json'), '{}')
          return {exitCode: 0, output: ''}
        },
        isEmptyExport: () => false,
        saveCache: async () => 23,
        emit: () => {},
        warn: () => {}
      })
      expect(result).toBe('saved')
    } finally {
      if (originalV2 === undefined) delete process.env.ACTIONS_CACHE_SERVICE_V2
      else process.env.ACTIONS_CACHE_SERVICE_V2 = originalV2
      if (originalServer === undefined) delete process.env.GITHUB_SERVER_URL
      else process.env.GITHUB_SERVER_URL = originalServer
    }

    const second = await setup()
    delete process.env.ACTIONS_CACHE_SERVICE_V2
    await expect(
      saveIsolatedObjectsBundle({
        paths: second.paths,
        primaryKey: 'generated-key',
        saveEligible: true,
        exactHit: false,
        cargoTarget: second.cargoTarget,
        exportBundle: async bundle => {
          await mkdir(bundle)
          await writeFile(path.join(bundle, 'manifest.json'), '{}')
          return {exitCode: 0, output: ''}
        },
        isEmptyExport: () => false,
        saveCache: async () => 23,
        emit: () => {},
        warn: () => {}
      })
    ).rejects.toThrow(/did not provide evidence/)
  })
})
