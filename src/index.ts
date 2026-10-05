import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'
import {createHash} from 'node:crypto'
import {access, chmod, mkdir, readFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
import {
  archiveExtractionEnvironment,
  mbxChildEnvironment,
  snapshotTransportEnvironment,
  withTemporaryProcessEnvironment
} from './child-env.js'
import {
  createNativeSnapshotStore,
  nativeSnapshotComparisonStateExists,
  nativeSnapshotComparisonStatePath,
  nativeSnapshotImportArgs,
  parseNativeSnapshotImportReport,
  nativeSnapshotSelection,
  type NativeSnapshotSelection
} from './native-snapshot.js'
import {
  cacheLinksValue,
  callingCard,
  type CallingCardRow,
  githubApiHeaders,
  normalizedVersion,
  parsedMbxVersion,
  releaseTarget,
  remoteExports,
  verifiedReleaseAsset,
  type GithubRelease,
  type VerifiedReleaseAsset
} from './lib.js'
import {
  preinstalledInputs,
  verifyPreinstalledMbxFile,
  verifiedPreinstalledMbx,
  type MbxInstallation
} from './preinstalled.js'

const MBX_SELECTED_BIN_STATE = 'mbx-selected-bin'
const MBX_DIGEST_STATE = 'mbx-executable-sha256'

async function leaveCallingCard(note: string, rows: CallingCardRow[]): Promise<void> {
  try {
    await core.summary
      .addDetails(
        '📦 <strong>Mr Boxington inspected the premises.</strong>',
        callingCard(note, rows)
      )
      .write()
  } catch (error) {
    core.debug(`Could not write Mr Boxington's run summary: ${String(error)}`)
  }
}

async function capture(command: string, args: string[], cwd?: string): Promise<string> {
  let output = ''
  const selectedBin = core.getState(MBX_SELECTED_BIN_STATE)
  const expectedDigest = core.getState(MBX_DIGEST_STATE)
  const verifySelected = Boolean(selectedBin && command === selectedBin && expectedDigest)
  if (verifySelected) await verifyPreinstalledMbxFile(command, expectedDigest)
  try {
    const exitCode = await exec.exec(command, args, {
      cwd,
      env: mbxChildEnvironment(),
      silent: true,
      listeners: {stdout: data => (output += data.toString())}
    })
    if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode}`)
    return output.trim()
  } finally {
    if (verifySelected) await verifyPreinstalledMbxFile(command, expectedDigest)
  }
}

async function resolveRelease(requested: string, archiveName: string): Promise<VerifiedReleaseAsset> {
  const endpoint =
    requested === 'latest'
      ? 'https://api.github.com/repos/jdx/mr-boxington/releases/latest'
      : `https://api.github.com/repos/jdx/mr-boxington/releases/tags/v${encodeURIComponent(requested)}`
  const response = await fetch(endpoint, {
    headers: githubApiHeaders(''),
    redirect: 'error'
  })
  if (!response.ok) {
    throw new Error(`could not resolve mbx ${requested}: GitHub returned ${response.status}`)
  }
  return verifiedReleaseAsset((await response.json()) as GithubRelease, requested, archiveName)
}

async function installMbx(requested: string): Promise<MbxInstallation> {
  const requestedVersion = normalizedVersion(requested)
  const target = releaseTarget(process.platform, process.arch)
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const archiveName = `mbx-${target}.${extension}`
  const {version, sha256} = await resolveRelease(requestedVersion, archiveName)
  const toolName = `mbx-${sha256}`
  const found = tc.find(toolName, version)
  if (found) {
    core.addPath(found)
    return {bin: path.join(found, process.platform === 'win32' ? 'mbx.exe' : 'mbx'), version}
  }

  const base = `https://github.com/jdx/mr-boxington/releases/download/v${version}`
  const archive = await tc.downloadTool(`${base}/${archiveName}`)
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (actual !== sha256) throw new Error(`checksum mismatch for ${archiveName}`)

  const extracted = await withTemporaryProcessEnvironment(
    archiveExtractionEnvironment(),
    () => process.platform === 'win32' ? tc.extractZip(archive) : tc.extractTar(archive)
  )
  const extractedBin = path.join(extracted, process.platform === 'win32' ? 'mbx.exe' : 'mbx')
  if (process.platform !== 'win32') await chmod(extractedBin, 0o755)
  const rawVersion = await capture(extractedBin, ['--version'])
  const installedVersion = parsedMbxVersion(rawVersion)
  if (!installedVersion) throw new Error(`could not parse mbx version from ${JSON.stringify(rawVersion)}`)
  if (installedVersion !== version) {
    throw new Error(`mbx archive for ${version} contains version ${installedVersion}`)
  }
  const toolDir = await tc.cacheDir(extracted, toolName, installedVersion)
  core.addPath(toolDir)
  return {
    bin: path.join(toolDir, process.platform === 'win32' ? 'mbx.exe' : 'mbx'),
    version: installedVersion
  }
}

async function mbxOnPath(): Promise<MbxInstallation | undefined> {
  try {
    const names = process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(extension => `mbx${extension}`)
      : ['mbx']
    let bin = ''
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of names) {
        const candidate = path.resolve(directory, name)
        try {
          await access(candidate, constants.X_OK)
          bin = candidate
          break
        } catch {}
      }
      if (bin) break
    }
    if (!bin) throw new Error('mbx was not found on PATH')
    const version = parsedMbxVersion(await capture(bin, ['--version']))
    if (!version) throw new Error('could not parse mbx version from PATH')
    return {bin, version}
  } catch (error) {
    core.debug(`mbx PATH probe failed: ${String(error)}`)
    return undefined
  }
}

async function setupMbx(requested: string): Promise<MbxInstallation> {
  if (!requested) {
    const found = await mbxOnPath()
    if (found) {
      core.info(`Using mbx ${found.version} from PATH`)
      return found
    }
  }
  return installMbx(requested ? normalizedVersion(requested) : 'latest')
}

function configureRemote(): boolean {
  const variables = remoteExports({
    url: core.getInput('remote-url'),
    namespace: core.getInput('namespace'),
    token: core.getInput('token'),
    tokenFile: core.getInput('token-file'),
    oidcAudience: core.getInput('oidc-audience'),
    mode: core.getInput('remote-mode')
  })
  if (variables.MBX_REMOTE_TOKEN) core.setSecret(variables.MBX_REMOTE_TOKEN)
  for (const [name, value] of Object.entries(variables)) core.exportVariable(name, value)
  return Boolean(
    variables.MBX_REMOTE_URL || process.env.MBX_REMOTE_URL || variables.MBX_REMOTE_NAMESPACE ||
      process.env.MBX_REMOTE_NAMESPACE
  )
}

async function importNativeSnapshot(
  mbx: string,
  selection: Exclude<NativeSnapshotSelection, {kind: 'none'}>,
  cacheDirectory: string,
  runnerTemp: string,
  token: string,
  expectedDigest: string
): Promise<{authenticatedImported: boolean; workspaceRestored: boolean}> {
  if (!token) {
    core.warning('Native snapshot was not restored because the snapshot read token is unavailable; continuing cold')
    return {authenticatedImported: false, workspaceRestored: false}
  }
  const workspace = process.env.GITHUB_WORKSPACE
  if (!workspace) {
    core.warning('Native snapshot was not restored because GITHUB_WORKSPACE is unavailable; continuing cold')
    return {authenticatedImported: false, workspaceRestored: false}
  }
  const args = nativeSnapshotImportArgs(selection)
  let output = ''
  await verifyPreinstalledMbxFile(mbx, expectedDigest)
  let exitCode: number
  try {
    exitCode = await exec.exec(mbx, args, {
      env: snapshotTransportEnvironment(token, cacheDirectory, runnerTemp),
      cwd: workspace,
      ignoreReturnCode: true,
      silent: true,
      listeners: {stdout: data => (output += data.toString())}
    })
  } catch (error) {
    core.debug(`Native snapshot import failed closed: ${String(error)}`)
    core.warning('Native snapshot is unavailable or inadmissible; continuing cold')
    if (await nativeSnapshotComparisonStateExists(cacheDirectory)) {
      throw new Error('native snapshot importer left comparison state after an unsuccessful import')
    }
    return {authenticatedImported: false, workspaceRestored: false}
  }
  await verifyPreinstalledMbxFile(mbx, expectedDigest)
  if (exitCode !== 0) {
    core.warning('Native snapshot is unavailable or inadmissible; continuing cold')
    if (await nativeSnapshotComparisonStateExists(cacheDirectory)) {
      throw new Error('native snapshot importer left comparison state after an unsuccessful import')
    }
    return {authenticatedImported: false, workspaceRestored: false}
  }
  const report = parseNativeSnapshotImportReport(output)
  if (report.kind === 'cold-miss' || report.kind === 'invalid') {
    if (await nativeSnapshotComparisonStateExists(cacheDirectory)) {
      throw new Error('native snapshot importer left comparison state without an authenticated import report')
    }
    if (report.kind === 'invalid') core.debug('Native snapshot report failed closed')
    core.warning('Native snapshot is unavailable or inadmissible; continuing cold')
    return {authenticatedImported: false, workspaceRestored: false}
  }
  if (!await nativeSnapshotComparisonStateExists(cacheDirectory)) {
    throw new Error('authenticated native snapshot import did not create its fixed comparison state')
  }
  if (report.workspaceRestored) core.info('Restored authenticated native snapshot')
  else core.info('Authenticated native snapshot was imported; MBX left the existing workspace unchanged')
  return {authenticatedImported: true, workspaceRestored: report.workspaceRestored}
}

async function main(): Promise<void> {
  const backend = core.getInput('backend') || 'local'
  if (backend !== 'local' && backend !== 'remote') {
    throw new Error(`backend must be "local" or "remote", got ${JSON.stringify(backend)}`)
  }
  const externalBin = core.getInput('mbx-path')
  const expectedVersion = core.getInput('expected-version')
  const expectedBinaryDigest = core.getInput('expected-binary-sha256')
  const requestedVersion = core.getInput('version')
  const preinstalled = preinstalledInputs(
    externalBin,
    expectedVersion,
    requestedVersion,
    expectedBinaryDigest
  )
  const selection = nativeSnapshotSelection(
    core.getInput('snapshot-selection'),
    core.getInput('snapshot-artifact-id')
  )
  if (selection.kind !== 'none' && !preinstalled) {
    throw new Error('native snapshots require mbx-path, expected-version, and expected-binary-sha256')
  }

  const external = preinstalled
    ? await verifiedPreinstalledMbx(
        externalBin,
        expectedVersion,
        expectedBinaryDigest,
        capture,
        process.env.RUNNER_TEMP || ''
      )
    : undefined
  if (external) {
    core.saveState(MBX_SELECTED_BIN_STATE, external.bin)
    core.saveState(MBX_DIGEST_STATE, expectedBinaryDigest)
  }
  const installed = external ?? await setupMbx(requestedVersion)
  core.addPath(path.dirname(installed.bin))
  core.setOutput('mbx-version', installed.version)

  const cacheLinks = cacheLinksValue(core.getInput('cache-links'), process.platform)
  if (cacheLinks !== undefined) core.exportVariable('MBX_CACHE_LINKS', cacheLinks)

  let remoteConfigured = false
  if (backend === 'remote') {
    remoteConfigured = configureRemote()
    core.info('Configured remote MBX settings for later build steps')
  } else {
    core.exportVariable('MBX_REMOTE_URL', '')
  }

  let snapshotAuthenticated = false
  let snapshotImported = false
  let snapshotComparisonState = ''
  if (selection.kind !== 'none') {
    const {runnerTemp, cacheDirectory} = await createNativeSnapshotStore(process.env.RUNNER_TEMP || '')
    snapshotComparisonState = nativeSnapshotComparisonStatePath(cacheDirectory)
    core.exportVariable('MBX_CACHE_DIR', cacheDirectory)
    const readToken = core.getInput('snapshot-read-token')
    if (readToken) core.setSecret(readToken)
    const importResult = await importNativeSnapshot(
      installed.bin,
      selection,
      cacheDirectory,
      runnerTemp,
      readToken,
      expectedBinaryDigest
    )
    snapshotAuthenticated = importResult.authenticatedImported
    snapshotImported = importResult.workspaceRestored
  }
  core.setOutput('native-snapshot-imported', snapshotImported ? 'true' : 'false')
  core.setOutput('native-snapshot-comparison-state', snapshotComparisonState)

  const snapshotSummary = snapshotAuthenticated
    ? snapshotImported
      ? 'authenticated snapshot imported'
      : 'authenticated snapshot imported; workspace unchanged'
    : 'cold start'
  const backendRows: CallingCardRow[] = [
    {label: 'mbx', value: installed.version},
    {label: 'Backend', value: backend === 'local' ? 'local filesystem' : 'remote cache'},
    {label: 'Native snapshot', value: snapshotSummary}
  ]
  if (backend === 'local') {
    const cacheDir = await capture(installed.bin, ['cache', 'dir'])
    await mkdir(cacheDir, {recursive: true})
    backendRows.push({label: 'Cache', value: cacheDir})
  } else {
    backendRows.push({label: 'Remote settings', value: remoteConfigured ? 'configured' : 'inherited or MBX config'})
  }
  const summaryNote = snapshotAuthenticated
    ? snapshotImported
      ? 'Just as I left it.'
      : 'Snapshot checked; I left the existing workspace as I found it.'
    : 'No snapshot restored; starting cold.'
  await leaveCallingCard(summaryNote, backendRows)
}

main().catch(error => core.setFailed(error instanceof Error ? error : String(error)))
