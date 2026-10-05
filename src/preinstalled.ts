import {constants} from 'node:fs'
import {access, chmod, lstat, mkdtemp, open, realpath, rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'

export interface MbxInstallation {
  bin: string
  version: string
}

type Capture = (command: string, args: string[]) => Promise<string>

/** An explicit executable is authoritative: failure never falls back to installation. */
export function preinstalledInputs(bin: string, expected: string, release: string, digest = ''): boolean {
  if (!bin && !expected && !digest) return false
  if (!bin || !expected || !digest) throw new Error('mbx-path, expected-version, and expected-binary-sha256 must be supplied together')
  if (release) throw new Error('version cannot be combined with mbx-path and expected-version')
  if (!path.isAbsolute(bin)) throw new Error('mbx-path must be an absolute executable path')
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('expected-binary-sha256 must be exactly 64 lowercase hexadecimal characters')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expected)) {
    throw new Error('expected-version must be an exact mbx version, without a v prefix')
  }
  return true
}

export async function verifiedPreinstalledMbx(
  bin: string,
  expected: string,
  digest: string,
  capture: Capture,
  runnerTemp: string
): Promise<MbxInstallation> {
  preinstalledInputs(bin, expected, '', digest)
  const resolved = await realpath(bin)
  const source = await openVerifiedExecutable(resolved, digest, 'mbx-path')
  const tempRoot = await canonicalRunnerTemp(runnerTemp)
  const privateDirectory = await mkdtemp(path.join(tempRoot, 'mbx-verified-'))
  let keepDirectory = false
  try {
    await chmod(privateDirectory, 0o700)
    await requirePrivateDirectory(privateDirectory)
    const stagedBin = path.join(privateDirectory, path.basename(resolved))
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)
    const staged = await open(stagedBin, flags, process.platform === 'win32' ? 0o700 : 0o500)
    try {
      await staged.writeFile(source)
      await staged.sync()
    } finally {
      await staged.close()
    }
    if (process.platform !== 'win32') await chmod(stagedBin, 0o500)
    await verifyPreinstalledMbx(stagedBin, expected, digest, capture)
    keepDirectory = true
    return {bin: stagedBin, version: expected}
  } finally {
    if (!keepDirectory) await removePrivateDirectory(privateDirectory)
  }
}

export async function verifyPreinstalledMbx(
  bin: string,
  expected: string,
  digest: string,
  capture: Capture
): Promise<void> {
  await verifyPreinstalledMbxFile(bin, digest)
  const banner = await capture(bin, ['--version'])
  await verifyPreinstalledMbxFile(bin, digest)
  if (banner !== `mbx ${expected}`) {
    throw new Error(`mbx-path expected mbx ${expected}, received ${JSON.stringify(banner)}`)
  }
}

export async function verifyPreinstalledMbxFile(bin: string, digest: string): Promise<void> {
  await openVerifiedExecutable(bin, digest, 'Verified preinstalled mbx executable')
}

async function openVerifiedExecutable(bin: string, digest: string, label: string): Promise<Buffer> {
  const canonical = await realpath(bin)
  if (canonical !== path.resolve(bin)) {
    throw new Error(`${label} path is not canonical: ${bin}`)
  }
  const before = await lstat(canonical)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} is not a regular file: ${bin}`)
  }
  await access(canonical, constants.X_OK)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
  const handle = await open(canonical, flags)
  try {
    const opened = await handle.stat()
    if (!sameFile(before, opened) || !opened.isFile()) {
      throw new Error(`${label} changed while opening: ${bin}`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!sameFile(opened, after)) throw new Error(`${label} changed while reading: ${bin}`)
    const observed = createHash('sha256').update(bytes).digest('hex')
    if (observed !== digest) throw new Error(`${label} SHA-256 does not match expected-binary-sha256`)
    return bytes
  } finally {
    await handle.close()
  }
}

function sameFile(left: import('node:fs').Stats, right: import('node:fs').Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

async function canonicalRunnerTemp(runnerTemp: string): Promise<string> {
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error('RUNNER_TEMP must be an absolute directory for verified mbx staging')
  }
  const canonical = await realpath(runnerTemp)
  const info = await lstat(canonical)
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path.resolve(canonical)) {
    throw new Error('RUNNER_TEMP must resolve to a canonical regular directory')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('RUNNER_TEMP must be owned by the current runner user')
  }
  return canonical
}

async function requirePrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error('Verified mbx staging directory is not canonical')
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Verified mbx staging directory is accessible to other users')
  }
}

async function removePrivateDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory)
    if (info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory) {
      await rm(directory, {recursive: true, force: true})
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
