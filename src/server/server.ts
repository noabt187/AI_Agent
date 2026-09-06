import { startAiAgentProfile } from '../plugins/host.js'

const profile = process.env.AI_AGENT_PROFILE?.trim() || 'web'
const host = await startAiAgentProfile(profile)

console.log(
  `Agent web server listening on http://${host.ctx.webServer.host}:${host.ctx.webServer.port}`,
)

let stopping = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  await host.dispose()
  console.log(`Agent web server stopped after ${signal}`)
}

const onSigint = () => { void shutdown('SIGINT') }
const onSigterm = () => { void shutdown('SIGTERM') }
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)
