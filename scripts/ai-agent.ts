import { pathToFileURL } from 'node:url'
import { runPluginCommand } from '../src/plugins/manager.js'
import { prepareAiAgentProfile, startAiAgentProfile } from '../src/plugins/host.js'

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
  if (parsed.rest.includes('--dump-config')) {
    io.stdout.write(prepareAiAgentProfile(parsed.profile).yaml)
    return 0
  }
  const host = await startAiAgentProfile(parsed.profile)
  const shutdown = async (signal: NodeJS.Signals) => {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    await host.dispose()
    io.stderr.write(`ai-agent: stopped after ${signal}\n`)
  }
  const onSigint = () => { void shutdown('SIGINT') }
  const onSigterm = () => { void shutdown('SIGTERM') }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return 0
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
