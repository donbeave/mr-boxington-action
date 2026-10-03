import {Buffer} from 'node:buffer'
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs} from 'node:fs/promises'
import path from 'node:path'

export type ObjectsBundleForm = 'directory' | 'tar'

export interface ObjectsCachePaths {
  runnerTemp: string
  root: string
  store: string
  bundle: string
  form: ObjectsBundleForm
}

export interface TreeUsage {
  files: number
  directories: number
  symlinks: number
  uniqueInodes: number
  apparentBytes: string
  uniqueApparentBytes: string
  uniqueInodeAllocatedBytes: string
  hardlinkAliases: number
  entriesScanned: number
  complete: boolean
}

export interface MountUsage {
  identity: string
  roles: string[]
  freeBytes: string
  freeInodes: string
}

export interface ResourcePhase {
  schema: 1
  phase: string
  mounts: MountUsage[]
  mbxStore: TreeUsage | null
  mbxActions: TreeUsage | null
  mbxTargets: TreeUsage | null
  bundle: TreeUsage | null
  cargoTarget: (TreeUsage & {capturedAt: string}) | null
  accounting: string
}

const MAX_TREE_ENTRIES = 1_000_000
const SAMPLER_INTERVAL_MS = 250
const MISSING = Symbol('missing')

function bundleName(form: ObjectsBundleForm): string {
  return form === 'directory' ? 'mbx-github-objects-bundle-v1' : 'mbx-github-objects-bundle-v1.tar'
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

async function maybeLstat(value: string) {
  try {
    return await lstat(value, {bigint: true})
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return MISSING
    throw error
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function createObjectsCachePaths(
  runnerTempInput: string,
  form: ObjectsBundleForm
): Promise<ObjectsCachePaths> {
  if (!runnerTempInput || !path.isAbsolute(runnerTempInput)) {
    throw new Error('RUNNER_TEMP must be an absolute directory for isolated objects caching')
  }
  const tempStat = await lstat(runnerTempInput)
  if (tempStat.isSymbolicLink() || !tempStat.isDirectory()) {
    throw new Error('RUNNER_TEMP must be a real directory for isolated objects caching')
  }
  const runnerTemp = await realpath(runnerTempInput)
  const bundle = path.join(runnerTemp, bundleName(form))
  if (await maybeLstat(bundle) !== MISSING) {
    throw new Error('stable isolated objects bundle path already exists in RUNNER_TEMP')
  }
  const root = await mkdtemp(path.join(runnerTemp, 'mbx-github-objects-store-'))
  const paths: ObjectsCachePaths = {
    runnerTemp,
    root,
    store: path.join(root, 'store'),
    bundle,
    form
  }
  await mkdir(paths.store)
  await validateObjectsCachePaths(paths)
  return paths
}

export async function pathsFromObjectsCacheRoot(
  runnerTempInput: string,
  rootInput: string,
  form: ObjectsBundleForm
): Promise<ObjectsCachePaths> {
  if (!runnerTempInput || !path.isAbsolute(runnerTempInput)) {
    throw new Error('RUNNER_TEMP must be an absolute directory for isolated objects caching')
  }
  const runnerTemp = await realpath(runnerTempInput)
  const root = path.resolve(rootInput)
  const paths: ObjectsCachePaths = {
    runnerTemp,
    root,
    store: path.join(root, 'store'),
    bundle: path.join(runnerTemp, bundleName(form)),
    form
  }
  await validateObjectsCachePaths(paths)
  return paths
}

export async function validateObjectsCachePaths(paths: ObjectsCachePaths): Promise<void> {
  const runnerTemp = path.resolve(paths.runnerTemp)
  const root = path.resolve(paths.root)
  const store = path.resolve(paths.store)
  const bundle = path.resolve(paths.bundle)
  const expectedBundle = path.join(runnerTemp, bundleName(paths.form))
  if (
    runnerTemp !== paths.runnerTemp ||
    root !== paths.root ||
    store !== paths.store ||
    bundle !== paths.bundle ||
    store !== path.join(root, 'store') ||
    bundle !== expectedBundle ||
    store === bundle ||
    isWithin(root, bundle) ||
    isWithin(bundle, root) ||
    path.dirname(root) !== runnerTemp ||
    path.dirname(bundle) !== runnerTemp ||
    !path.basename(root).startsWith('mbx-github-objects-store-')
  ) {
    throw new Error('isolated objects cache paths are not the exact private RUNNER_TEMP layout')
  }
  const [tempReal, rootStat, rootReal] = await Promise.all([
    realpath(runnerTemp),
    lstat(root),
    realpath(root)
  ])
  if (tempReal !== runnerTemp || rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootReal !== root) {
    throw new Error('isolated objects cache root is not a canonical private directory')
  }
  for (const value of [store, bundle]) {
    const found = await maybeLstat(value)
    if (found !== MISSING && found.isSymbolicLink()) {
      throw new Error(`isolated objects cache path ${path.basename(value)} must not be a symlink`)
    }
    if (found !== MISSING) {
      const actual = await realpath(value)
      const expectedParent = value === store ? root : runnerTemp
      if (actual !== value || !isWithin(expectedParent, actual)) {
        throw new Error(`isolated objects cache path ${path.basename(value)} is not canonical`)
      }
    }
  }
}

async function measureTree(target: string, rejectSymlinks: boolean): Promise<TreeUsage> {
  const rootStat = await lstat(target, {bigint: true})
  if (rootStat.isSymbolicLink()) throw new Error(`cache path ${path.basename(target)} is a symlink`)
  const pending = [target]
  const seenInodes = new Set<string>()
  let files = 0
  let directories = 0
  let symlinks = 0
  let entriesScanned = 0
  let apparentBytes = 0n
  let uniqueApparentBytes = 0n
  let uniqueInodeAllocatedBytes = 0n
  let hardlinkAliases = 0
  let complete = true

  while (pending.length > 0) {
    const current = pending.pop()!
    const info = await lstat(current, {bigint: true})
    entriesScanned++
    if (entriesScanned > MAX_TREE_ENTRIES) {
      if (rejectSymlinks) {
        throw new Error(`exported cache bundle exceeds the ${MAX_TREE_ENTRIES} entry validation limit`)
      }
      complete = false
      break
    }
    const inode = `${info.dev}:${info.ino}`
    const firstInode = !seenInodes.has(inode)
    if (firstInode) {
      seenInodes.add(inode)
      uniqueInodeAllocatedBytes += info.blocks * 512n
    } else if (info.isFile()) {
      hardlinkAliases++
    }
    if (info.isSymbolicLink()) {
      symlinks++
      if (rejectSymlinks) {
        throw new Error(`exported cache bundle contains a symlink at ${path.basename(current)}`)
      }
      continue
    }
    if (info.isDirectory()) {
      directories++
      const names = await readdir(current)
      for (const name of names) pending.push(path.join(current, name))
    } else if (info.isFile()) {
      files++
      apparentBytes += info.size
      if (firstInode) uniqueApparentBytes += info.size
    } else if (rejectSymlinks) {
      throw new Error(`exported cache bundle contains a non-file entry at ${path.basename(current)}`)
    }
  }

  return {
    files,
    directories,
    symlinks,
    uniqueInodes: seenInodes.size,
    apparentBytes: apparentBytes.toString(),
    uniqueApparentBytes: uniqueApparentBytes.toString(),
    uniqueInodeAllocatedBytes: uniqueInodeAllocatedBytes.toString(),
    hardlinkAliases,
    entriesScanned,
    complete
  }
}

export async function validateObjectsBundle(paths: ObjectsCachePaths): Promise<TreeUsage> {
  await validateObjectsCachePaths(paths)
  const info = await maybeLstat(paths.bundle)
  if (info === MISSING) throw new Error('mbx cache export did not create its private bundle')
  if (paths.form === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`mbx cache export created the wrong bundle type for ${paths.form} format`)
  }
  const usage = await measureTree(paths.bundle, true)
  if (usage.files === 0 || usage.apparentBytes === '0') {
    throw new Error('mbx cache export created an empty bundle')
  }
  return usage
}

export async function assertObjectsBundleAbsent(paths: ObjectsCachePaths): Promise<void> {
  await validateObjectsCachePaths(paths)
  if (await maybeLstat(paths.bundle) !== MISSING) {
    throw new Error('private objects bundle exists when no cache restore was reported')
  }
}

export async function importObjectsBundle(
  paths: ObjectsCachePaths,
  importBundle: (bundlePath: string) => Promise<void>
): Promise<void> {
  await validateObjectsBundle(paths)
  await importBundle(paths.bundle)
  // MBX 1.22 removes directory bundles after a successful import. The tar
  // compatibility form is still action-owned, so both forms use the same
  // post-import cleanup after MBX returns successfully.
  const info = await maybeLstat(paths.bundle)
  if (info !== MISSING) {
    await validateObjectsCachePaths(paths)
    await rm(paths.bundle, {recursive: true, force: false})
  }
}

export async function removeObjectsStore(paths: ObjectsCachePaths): Promise<void> {
  await validateObjectsCachePaths(paths)
  const info = await maybeLstat(paths.store)
  if (info === MISSING) return
  if (!info.isDirectory()) throw new Error('isolated mbx store is not a directory')
  await rm(paths.store, {recursive: true, force: false})
}

export async function removeObjectsBundle(paths: ObjectsCachePaths): Promise<void> {
  await validateObjectsCachePaths(paths)
  const info = await maybeLstat(paths.bundle)
  if (info === MISSING) return
  await rm(paths.bundle, {recursive: true, force: false})
}

async function canonicalExistingDirectory(target: string): Promise<string | undefined> {
  let current = path.resolve(target)
  while (true) {
    const found = await maybeLstat(current)
    if (found !== MISSING) {
      if (found.isSymbolicLink()) return undefined
      if (!found.isDirectory()) current = path.dirname(current)
      else return realpath(current)
    } else {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

async function linuxMountIdentity(target: string): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8')
    const unescape = (value: string) =>
      value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\')
    const mounts = mountInfo.split('\n').flatMap(line => {
      if (!line) return []
      const [left, right] = line.split(' - ')
      const fields = left?.split(' ') ?? []
      const tail = right?.split(' ') ?? []
      const mountPoint = unescape(fields[4] ?? '')
      if (!mountPoint || !fields[0] || !fields[2] || !tail[0]) return []
      return [{id: fields[0], device: fields[2], mountPoint, type: tail[0]}]
    })
    const match = mounts
      .filter(item => target === item.mountPoint || target.startsWith(`${item.mountPoint.replace(/\/$/, '')}/`))
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]
    return match ? `${match.id}:${match.device}:${match.type}` : undefined
  } catch {
    return undefined
  }
}

async function mountUsage(target: string, role: string): Promise<MountUsage | undefined> {
  const existingDirectory = await canonicalExistingDirectory(target)
  if (!existingDirectory) return undefined
  const [fsStats, targetStats, identity] = await Promise.all([
    statfs(existingDirectory, {bigint: true}),
    lstat(existingDirectory, {bigint: true}),
    linuxMountIdentity(existingDirectory)
  ])
  const key = identity ?? `${targetStats.dev}:${fsStats.type}`
  return {
    identity: key,
    roles: [role],
    freeBytes: (fsStats.bavail * fsStats.bsize).toString(),
    freeInodes: fsStats.ffree.toString()
  }
}

async function mountUsages(paths: ObjectsCachePaths, cargoTarget: string): Promise<MountUsage[]> {
  const samples = await Promise.all([
    mountUsage(paths.runnerTemp, 'runnerTemp'),
    mountUsage(paths.root, 'objectsCache'),
    mountUsage(paths.store, 'mbxStore'),
    mountUsage(paths.bundle, 'bundle'),
    mountUsage(cargoTarget, 'cargoTarget')
  ])
  const unique = new Map<string, MountUsage>()
  for (const sample of samples) {
    if (!sample) continue
    const existing = unique.get(sample.identity)
    if (existing) {
      existing.roles.push(...sample.roles)
      if (BigInt(sample.freeBytes) < BigInt(existing.freeBytes)) existing.freeBytes = sample.freeBytes
      if (BigInt(sample.freeInodes) < BigInt(existing.freeInodes)) existing.freeInodes = sample.freeInodes
    } else unique.set(sample.identity, sample)
  }
  return [...unique.values()]
}

async function treeUsageIfPresent(target: string, rejectSymlinks = false): Promise<TreeUsage | null> {
  const found = await maybeLstat(target)
  if (found === MISSING) return null
  return measureTree(target, rejectSymlinks)
}

export async function reportObjectsResourcePhase(
  paths: ObjectsCachePaths,
  phase: string,
  cargoTarget: string,
  emit: (message: string) => void,
  cachedCargoTarget?: TreeUsage & {capturedAt: string}
): Promise<(TreeUsage & {capturedAt: string}) | null> {
  await validateObjectsCachePaths(paths)
  const [mounts, storeUsage, bundleUsage] = await Promise.all([
    mountUsages(paths, cargoTarget),
    treeUsageIfPresent(paths.store),
    treeUsageIfPresent(paths.bundle, true)
  ])
  const [actionsUsage, targetsUsage] = await Promise.all([
    treeUsageIfPresent(path.join(paths.store, 'actions')),
    treeUsageIfPresent(path.join(paths.store, 'targets'))
  ])
  const targetUsage = cachedCargoTarget ?? (await treeUsageIfPresent(cargoTarget))
  const cargo = targetUsage
    ? {...targetUsage, capturedAt: cachedCargoTarget?.capturedAt ?? phase}
    : null
  const record: ResourcePhase = {
    schema: 1,
    phase,
    mounts,
    mbxStore: storeUsage,
    mbxActions: actionsUsage,
    mbxTargets: targetsUsage,
    bundle: bundleUsage,
    cargoTarget: cargo,
    accounting:
      'apparent bytes count regular-file paths; allocated bytes sum st_blocks for unique inodes; ' +
      'hardlinks are deduped, reflink/shared extents cannot be deduped with Node stat; ' +
      'mbxStore, mbxActions, and mbxTargets overlap and must not be summed'
  }
  emit(`Objects cache resources ${JSON.stringify(record)}`)
  return cargo
}

export interface SampledArchiveUsage {
  observed: boolean
  samples: number
  peakApparentBytes: string | null
  peakAllocatedBytes: string | null
}

async function cacheArchiveFiles(runnerTemp: string): Promise<Array<{path: string; size: bigint; allocated: bigint; mtimeMs: number}>> {
  const archives: Array<{path: string; size: bigint; allocated: bigint; mtimeMs: number}> = []
  let children: string[]
  try {
    children = await readdir(runnerTemp)
  } catch {
    return archives
  }
  for (const child of children) {
    const folder = path.join(runnerTemp, child)
    const folderStat = await maybeLstat(folder)
    if (folderStat === MISSING || !folderStat.isDirectory() || folderStat.isSymbolicLink()) continue
    for (const name of ['cache.tgz', 'cache.tzst']) {
      const file = path.join(folder, name)
      const info = await maybeLstat(file)
      if (info !== MISSING && info.isFile()) {
        archives.push({path: file, size: info.size, allocated: info.blocks * 512n, mtimeMs: Number(info.mtimeNs / 1_000_000n)})
      }
    }
  }
  return archives
}

export async function withObjectsResourceSampler<T>(
  paths: ObjectsCachePaths,
  cargoTarget: string,
  phase: string,
  operation: () => Promise<T>,
  emit: (message: string) => void
): Promise<{result: T; archives: SampledArchiveUsage}> {
  const minima = new Map<string, MountUsage>()
  const archive = {observed: false, samples: 0, peakApparentBytes: null as string | null, peakAllocatedBytes: null as string | null}
  let sampling = false
  let sampleCount = 0
  const startTime = Date.now()
  let previousSampleAt: number | undefined
  let maxObservedIntervalMs = 0
  const baseline = new Map(
    (await cacheArchiveFiles(paths.runnerTemp)).map(value => [value.path, `${value.size}:${value.mtimeMs}`])
  )
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      sampleCount++
      const sampledAt = Date.now()
      if (previousSampleAt !== undefined) {
        maxObservedIntervalMs = Math.max(maxObservedIntervalMs, sampledAt - previousSampleAt)
      }
      previousSampleAt = sampledAt
      for (const usage of await mountUsages(paths, cargoTarget)) {
        const current = minima.get(usage.identity)
        if (!current) minima.set(usage.identity, {...usage, roles: [...usage.roles]})
        else {
          current.roles = [...new Set([...current.roles, ...usage.roles])]
          if (BigInt(usage.freeBytes) < BigInt(current.freeBytes)) current.freeBytes = usage.freeBytes
          if (BigInt(usage.freeInodes) < BigInt(current.freeInodes)) current.freeInodes = usage.freeInodes
        }
      }
      const staged = await cacheArchiveFiles(paths.runnerTemp)
      for (const candidate of staged) {
        if (baseline.get(candidate.path) === `${candidate.size}:${candidate.mtimeMs}`) continue
        archive.observed = true
        archive.samples++
        const apparent = BigInt(archive.peakApparentBytes ?? '0')
        const allocated = BigInt(archive.peakAllocatedBytes ?? '0')
        if (candidate.size > apparent) archive.peakApparentBytes = candidate.size.toString()
        if (candidate.allocated > allocated) archive.peakAllocatedBytes = candidate.allocated.toString()
      }
    } finally {
      sampling = false
    }
  }
  await sample()
  const timer = setInterval(() => void sample(), SAMPLER_INTERVAL_MS)
  let result!: T
  let thrown: unknown
  try {
    result = await operation()
  } catch (error) {
    thrown = error
  } finally {
    clearInterval(timer)
    await sample()
    emit(
      `Objects cache sample ${JSON.stringify({
        schema: 1,
        phase,
        sampleIntervalMs: SAMPLER_INTERVAL_MS,
        maxObservedIntervalMs,
        durationMs: Date.now() - startTime,
        sampleCount,
        mounts: [...minima.values()],
        cacheArchiveStaging: archive,
        mbxExportStagingNote:
          phase === 'bundle-export'
            ? 'MBX writes a sibling temporary tree and atomically publishes it as bundle; bundle bytes below measure the published same tree, while statfs minima measure peak mount pressure'
            : undefined,
        cacheArchiveNote: archive.observed
          ? 'local actions/cache archive observed separately from saveCache result'
          : 'actions/cache archive was not observed during sampling; no upload size inferred'
      })}`
    )
  }
  if (thrown !== undefined) throw thrown
  return {result, archives: archive}
}

export type CacheSaveFailure =
  | 'service-reservation'
  | 'service-5xx'
  | 'network-transport'
  | 'local-storage'
  | 'unknown'

export function classifyCacheSaveFailure(output: string): CacheSaveFailure {
  if (/\b(?:ENOSPC|no space left on device|disk quota exceeded)\b/i.test(output)) {
    return 'local-storage'
  }
  if (
    /::warning::Failed to save: (?:reserveCache|uploadChunk \([^)]*\)|commitCache) failed: Cache service responded with 5\d\d/i.test(
      output
    ) ||
    /::warning::Failed to save: Failed to FinalizeCacheEntryUpload:[^\n]*Failed request: \(5\d\d\)/i.test(
      output
    )
  ) {
    return 'service-5xx'
  }
  if (
    /(?:^|\r?\n)Failed to save: Unable to reserve cache with key [^\r\n]*, another job may be creating this cache\.(?: More details: [^\r\n]*)?\r?(?:\n|$)/i.test(
      output
    )
  ) {
    return 'service-reservation'
  }
  if (
    /::warning::Failed to save: (?:reserveCache|uploadChunk \([^)]*\)|commitCache) failed:[^\n]*(?:Request timeout|\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\b)/i.test(
      output
    ) ||
    /::warning::Failed to save: Failed to FinalizeCacheEntryUpload:[^\n]*(?:Request timeout|\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\b)/i.test(
      output
    )
  ) {
    return 'network-transport'
  }
  return 'unknown'
}

export async function withBoundedActionOutput<T>(
  operation: () => Promise<T>
): Promise<{result: T; output: string}> {
  const chunks: string[] = []
  let length = 0
  const capture = (chunk: unknown) => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    chunks.push(value)
    length += value.length
    while (length > 16_384 && chunks.length > 0) {
      const excess = length - 16_384
      const first = chunks[0]!
      if (first.length <= excess) {
        chunks.shift()
        length -= first.length
      } else {
        chunks[0] = first.slice(excess)
        length -= excess
      }
    }
  }
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = function (chunk: never, ...args: never[]) {
    capture(chunk)
    return (stdout as (...values: never[]) => boolean).call(process.stdout, chunk, ...args)
  } as typeof process.stdout.write
  process.stderr.write = function (chunk: never, ...args: never[]) {
    capture(chunk)
    return (stderr as (...values: never[]) => boolean).call(process.stderr, chunk, ...args)
  } as typeof process.stderr.write
  try {
    return {result: await operation(), output: chunks.join('')}
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

export async function saveIsolatedObjectsBundle(options: {
  paths: ObjectsCachePaths
  primaryKey: string
  saveEligible: boolean
  exactHit: boolean
  cargoTarget: string
  exportBundle: (bundlePath: string) => Promise<{exitCode: number; output: string}>
  isEmptyExport: (output: string) => boolean
  saveCache: (paths: string[], primaryKey: string) => Promise<number>
  emit: (message: string) => void
  warn: (message: string) => void
}): Promise<'ineligible' | 'exact-hit' | 'empty' | 'saved' | 'save-unavailable'> {
  await validateObjectsCachePaths(options.paths)
  await reportObjectsResourcePhase(
    options.paths,
    'after-build-before-export',
    options.cargoTarget,
    options.emit
  )
  if (!options.saveEligible) return 'ineligible'
  if (options.exactHit) return 'exact-hit'
  if (await maybeLstat(options.paths.bundle) !== MISSING) {
    throw new Error('private objects bundle already exists before export')
  }
  const exported = await withObjectsResourceSampler(
    options.paths,
    options.cargoTarget,
    'bundle-export',
    () => options.exportBundle(options.paths.bundle),
    options.emit
  )
  if (exported.result.exitCode !== 0) {
    if (options.isEmptyExport(exported.result.output)) {
      await reportObjectsResourcePhase(
        options.paths,
        'after-bundle-export-empty',
        options.cargoTarget,
        options.emit
      )
      await assertObjectsBundleAbsent(options.paths)
      options.emit('No completed mbx build was recorded; not saving an empty cache')
      return 'empty'
    }
    throw new Error(`mbx cache export exited with code ${exported.result.exitCode}`)
  }
  await validateObjectsCachePaths(options.paths)
  const bundleUsage = await validateObjectsBundle(options.paths)
  const cargoUsage = await reportObjectsResourcePhase(
    options.paths,
    'after-bundle-export',
    options.cargoTarget,
    options.emit
  )
  await removeObjectsStore(options.paths)
  await reportObjectsResourcePhase(
    options.paths,
    'after-store-removal',
    options.cargoTarget,
    options.emit,
    cargoUsage ? {...cargoUsage, capturedAt: 'after-bundle-export'} : undefined
  )
  options.emit(
    `Objects cache local staging ${JSON.stringify({
      bundleApparentBytes: bundleUsage.apparentBytes,
      bundleAllocatedBytes: bundleUsage.uniqueInodeAllocatedBytes,
      bundleFiles: bundleUsage.files,
      note: 'bundle is local input to actions/cache; upload success is reported separately'
    })}`
  )
  const sampled = await withObjectsResourceSampler(
    options.paths,
    options.cargoTarget,
    'actions-cache-save',
    () => withBoundedActionOutput(() => options.saveCache([options.paths.bundle], options.primaryKey)),
    options.emit
  )
  const {result: saveResult, output} = sampled.result
  await reportObjectsResourcePhase(
    options.paths,
    'after-cache-save',
    options.cargoTarget,
    options.emit,
    cargoUsage ? {...cargoUsage, capturedAt: 'after-bundle-export'} : undefined
  )
  const failure = classifyCacheSaveFailure(output)
  if (
    failure === 'service-reservation' ||
    failure === 'service-5xx' ||
    failure === 'network-transport'
  ) {
    options.warn(`GitHub cache save skipped after classified ${failure}`)
    await removeObjectsBundle(options.paths)
    return 'save-unavailable'
  }
  if (failure === 'local-storage') {
    throw new Error('actions/cache could not stage the local archive because runner storage is full')
  }
  const v2CacheService =
    Boolean(process.env.ACTIONS_CACHE_SERVICE_V2) &&
    !(() => {
      try {
        const host = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com').hostname.toUpperCase()
        return host !== 'GITHUB.COM' && !host.endsWith('.GHE.COM') && !host.endsWith('.LOCALHOST')
      } catch {
        return true
      }
    })()
  const hasSuccessEvidence =
    output.includes('Cache saved successfully') || (v2CacheService && saveResult >= 0)
  if (saveResult < 0 || !hasSuccessEvidence) {
    throw new Error('actions/cache did not provide evidence that the objects bundle was saved')
  }
  options.emit(
    `Saved mbx objects bundle; actions/cache confirmed upload/finalization (service ${v2CacheService ? 'v2' : 'v1'})`
  )
  await removeObjectsBundle(options.paths)
  return 'saved'
}
