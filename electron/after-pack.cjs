const fs = require('fs/promises')
const path = require('path')

module.exports = async function copyNodePtyConptyRuntime(context) {
  if (context.electronPlatformName !== 'win32') return

  const architecture = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (!architecture) throw new Error(`Unsupported Windows architecture for node-pty ConPTY runtime: ${context.arch}`)

  const conptyRoot = path.join(context.packager.projectDir, 'node_modules', 'node-pty', 'third_party', 'conpty')
  const versions = (await fs.readdir(conptyRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const version = versions.at(-1)
  if (!version) throw new Error(`No node-pty ConPTY runtime found in ${conptyRoot}`)

  const source = path.join(conptyRoot, version, `win10-${architecture}`)
  const destination = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'conpty'
  )

  await fs.mkdir(destination, { recursive: true })
  await Promise.all(['conpty.dll', 'OpenConsole.exe'].map(file =>
    fs.copyFile(path.join(source, file), path.join(destination, file))
  ))
}
