import { execFileSync } from 'node:child_process'

const DEFAULT_PORTS = '3001,5173,5174,5175'
const portsArgIndex = process.argv.indexOf('--ports')
const cliPorts = portsArgIndex >= 0 ? process.argv[portsArgIndex + 1] : ''
const ports = (cliPorts || process.env.DEV_CLEAN_PORTS || DEFAULT_PORTS)
  .split(',')
  .map((port) => Number(port.trim()))
  .filter((port) => Number.isInteger(port) && port > 0)
const dryRun = process.argv.includes('--dry-run')

function findPids(port) {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' })
    return output.split('\n').map((pid) => Number(pid.trim())).filter(Boolean)
  } catch {
    return []
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const port of ports) {
  const pids = Array.from(new Set(findPids(port))).filter((pid) => pid !== process.pid)
  if (pids.length === 0) continue

  console.log(`[dev:cleanup] port ${port}: ${dryRun ? 'would stop' : 'stopping'} ${pids.join(', ')}`)
  if (dryRun) continue

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
}

if (!dryRun) {
  await new Promise((resolve) => setTimeout(resolve, 350))

  for (const port of ports) {
    for (const pid of findPids(port)) {
      if (!isAlive(pid)) continue
      console.log(`[dev:cleanup] port ${port}: force stopping ${pid}`)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}
