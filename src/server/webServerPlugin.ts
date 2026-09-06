import type { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { loadAppConfig } from '../config/appConfig.js'

export interface AiAgentWebServerConfig {
  host?: '127.0.0.1' | '0.0.0.0'
  port?: number
}

export const webServerPlugin = {
  name: 'ai-agent-web-server',
  async apply(ctx: Context, config: AiAgentWebServerConfig = {}) {
    const appConfig = loadAppConfig()
    await ctx.plugin(WebServer, {
      host: config.host ?? '127.0.0.1',
      port: config.port ?? appConfig.serverPort,
    })
  },
}

export default webServerPlugin
