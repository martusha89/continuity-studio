import { ZipArchive } from 'archiver'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = await realpath(process.cwd())
const outputDirectory = path.join(root, 'dist', 'downloads')
const archivePath = path.join(outputDirectory, 'continuity-studio-source.zip')
const checksumPath = `${archivePath}.sha256`
const archiveRoot = 'continuity-studio-source'
const fixedDate = new Date('2026-08-24T00:00:00.000Z')
const forbiddenNames = /(?:^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential|private-key|debug-dump|browser-trace).*)$/i
const allowedExtensions = new Set(['', '.css', '.html', '.json', '.md', '.png', '.svg', '.toml', '.ts', '.tsx'])

const gitRootOutput = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const gitRoot = await realpath(gitRootOutput)
if (path.relative(root, gitRoot) !== '') {
  throw new Error('Source packaging must run from the root of this Git worktree.')
}

const indexOutput = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--stage', '-z'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const trackedEntries = indexOutput.split('\0').filter(Boolean).map((record) => {
  const separator = record.indexOf('\t')
  if (separator < 0) throw new Error('Git returned an invalid tracked-file entry.')
  const [mode, , stage] = record.slice(0, separator).split(' ')
  const relativePath = record.slice(separator + 1).replaceAll('\\', '/')
  if (stage !== '0') throw new Error(`Refusing to package an unresolved index entry: ${relativePath}`)
  if (mode === '120000') throw new Error(`Refusing to package a tracked symlink: ${relativePath}`)
  if (mode !== '100644' && mode !== '100755') {
    throw new Error(`Refusing to package unsupported tracked entry ${relativePath} with mode ${mode}.`)
  }
  return relativePath
}).sort()

const seenPaths = new Set<string>()
for (const relativePath of trackedEntries) {
  if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`Refusing to package an out-of-root path: ${relativePath}`)
  }
  const collisionKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
  if (seenPaths.has(collisionKey)) throw new Error(`Refusing to package a duplicate archive path: ${relativePath}`)
  seenPaths.add(collisionKey)
  if (forbiddenNames.test(relativePath) || !allowedExtensions.has(path.posix.extname(relativePath).toLowerCase())) {
    throw new Error(`Refusing to package unexpected source file: ${relativePath}`)
  }
}

function isInsideRoot(candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function checkedSourcePath(relativePath: string): Promise<string> {
  const absolutePath = path.resolve(root, ...relativePath.split('/'))
  if (!isInsideRoot(absolutePath)) throw new Error(`Refusing to package an out-of-root path: ${relativePath}`)

  let currentPath = root
  for (const segment of relativePath.split('/')) {
    currentPath = path.join(currentPath, segment)
    const info = await lstat(currentPath)
    if (info.isSymbolicLink()) throw new Error(`Refusing to package a symlinked path: ${relativePath}`)
  }

  const resolvedPath = await realpath(absolutePath)
  if (!isInsideRoot(resolvedPath)) throw new Error(`Refusing to package an out-of-root path: ${relativePath}`)
  const info = await lstat(resolvedPath)
  if (!info.isFile()) throw new Error(`Refusing to package a non-file path: ${relativePath}`)
  return resolvedPath
}

const entries = await Promise.all(trackedEntries.map(async (relativePath) => {
  const sourcePath = await checkedSourcePath(relativePath)
  const content = await readFile(sourcePath)
  return {
    path: relativePath,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  }
}))

const manifest = Buffer.from(`${JSON.stringify({
  format: 'continuity-studio-source-manifest/v1',
  generatedFrom: 'tracked files in the current Git worktree',
  exclusions: ['untracked files', 'symlinks', 'out-of-root paths', 'credential-like filenames', '.env files', '.git', 'node_modules', 'dist', 'logs', 'browser traces', 'local tool state', 'unexpected file extensions'],
  files: entries.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
}, null, 2)}\n`)

await mkdir(outputDirectory, { recursive: true })
await new Promise<void>((resolve, reject) => {
  const output = createWriteStream(archivePath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  output.on('close', resolve)
  output.on('error', reject)
  archive.on('error', reject)
  archive.pipe(output)
  for (const entry of entries) {
    archive.append(entry.content, { name: `${archiveRoot}/${entry.path}`, date: fixedDate })
  }
  archive.append(manifest, { name: `${archiveRoot}/SOURCE-MANIFEST.json`, date: fixedDate })
  void archive.finalize()
})

const archive = await readFile(archivePath)
const checksum = createHash('sha256').update(archive).digest('hex')
await writeFile(checksumPath, `${checksum}  continuity-studio-source.zip\n`, 'utf8')
console.log(`Packaged ${entries.length} tracked source files (${archive.byteLength} bytes, SHA-256 ${checksum}).`)
