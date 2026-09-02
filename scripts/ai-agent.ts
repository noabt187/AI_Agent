import { pathToFileURL } from 'node:url'
import { runPluginCommand } from '../src/plugins/manager.js'

const USAGE = `Usage:
  ai-agent plugin --profile <name> <pnpm-args...>
  ai-agent --profile <name>
  ai-agent --profile <name> --dump-config
`

export async function main(
  argv: readonly string[],
  io: { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'> } = process,
): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(USAGE)
    return 0
  }
  if (argv[0] === 'plugin') {
    const parsed = parseProfile(argv.slice(1))
    if (parsed.error) {
      io.stderr.write(`${parsed.error}\n${USAGE}`)
      return 2
    }
    return runPluginCommand(parsed.profile, parsed.rest, { stdout: io.stdout, stderr: io.stderr })
  }
  const parsed = parseProfile(argv)
  if (parsed.error || parsed.rest.some(arg => arg !== '--dump-config')) {
    io.stderr.write(`${parsed.error ?? 'ai-agent: unknown argument'}\n${USAGE}`)
    return 2
  }
  io.stderr.write('ai-agent: profile startup is not available until the Cordis host is installed\n')
  return 1
}

function parseProfile(argv: readonly string[]): { profile: string; rest: string[]; error?: string } {
  const at = argv.indexOf('--profile')
  if (at < 0 || at + 1 >= argv.length || argv[at + 1].startsWith('-')) {
    return { profile: '', rest: [], error: 'ai-agent: --profile <name> is required' }
  }
  return {
    profile: argv[at + 1],
    rest: [...argv.slice(0, at), ...argv.slice(at + 2)],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
