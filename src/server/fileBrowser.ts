import { execFile } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type DirectoryEntry = {
  name: string
  path: string
}

type DirectoryListing = {
  path: string
  parentPath: string | null
  entries: DirectoryEntry[]
  isRootListing?: boolean
  canListRoots?: boolean
}

type DirectoryPickerResult = {
  path: string | null
}

type ListDirectoriesOptions = {
  roots?: boolean
}

function isWindows(): boolean {
  return platform() === 'win32'
}

function isWindowsRootPath(pathname: string): boolean {
  if (!isWindows()) return false
  const { root } = parse(pathname)
  return root.length > 0 && root.toLowerCase() === pathname.toLowerCase()
}

async function listWindowsRoots(): Promise<DirectoryListing> {
  const entries = await Promise.all(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter): Promise<DirectoryEntry | null> => {
      const drivePath = `${letter}:\\`
      try {
        await access(drivePath)
        return { name: `${letter}:`, path: drivePath }
      } catch {
        return null
      }
    }),
  )

  return {
    path: 'This PC',
    parentPath: null,
    entries: entries.filter((entry): entry is DirectoryEntry => Boolean(entry)),
    isRootListing: true,
    canListRoots: true,
  }
}

export async function listDirectories(rawPath?: string, options: ListDirectoriesOptions = {}): Promise<DirectoryListing> {
  const requestedPath = rawPath?.trim()
  if (requestedPath && !isAbsolute(requestedPath)) throw new Error('请输入文件夹绝对路径')
  if (options.roots && isWindows()) {
    return listWindowsRoots()
  }

  const currentPath = resolve(options.roots ? parse(homedir()).root : requestedPath || homedir())
  try {
    const info = await stat(currentPath)
    if (!info.isDirectory()) throw new Error('该路径是文件，请选择文件夹')
    const entries = await readdir(currentPath, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: resolve(currentPath, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parentPath = dirname(currentPath)
    return {
      path: currentPath,
      parentPath: parentPath === currentPath || isWindowsRootPath(currentPath) ? null : parentPath,
      entries: dirs,
      isRootListing: false,
      canListRoots: isWindows(),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('文件夹不存在，请检查路径或返回主目录')
    if (code === 'EACCES' || code === 'EPERM') throw new Error('没有权限读取此文件夹，请选择其他目录')
    throw error
  }
}

export async function pickDirectory(initialPath?: string): Promise<DirectoryPickerResult> {
  if (!isWindows()) {
    throw new Error('Native directory picker is only supported on Windows')
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select Agent workspace folder'
$dialog.ShowNewFolderButton = $true
$initial = [Environment]::GetEnvironmentVariable('AGENT_INITIAL_DIRECTORY')
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_INITIAL_DIRECTORY: initialPath ? resolve(initialPath) : '',
      },
      windowsHide: false,
    },
  )

  const path = stdout.toString().trim()
  return { path: path || null }
}
