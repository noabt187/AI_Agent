import { Context, Service } from '@deepseek-ai/cordis'
import type { Orchestrator } from '../../orchestrator/orchestrator.js'
import { observeLiveSessions } from '../../server/sessionApi.js'

export interface DshSessionFacade {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
  }
}

export class UnsupportedSessionCapabilityError extends Error {
  readonly code = 'UNSUPPORTED_SESSION_CAPABILITY'

  constructor(capability: string) {
    super(`UNSUPPORTED_SESSION_CAPABILITY: AI Agent Session does not implement ${capability}`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: AiAgentSessionStore
  }
}

export class AiAgentSessionStore extends Service {
  private readonly live = new Map<string, DshSessionFacade>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  [Service.init](): () => void {
    return observeLiveSessions(event => {
      if (event.type === 'loaded') {
        this.attach(event.sessionId, event.orchestrator, event.createdAt)
      } else {
        this.live.delete(event.sessionId)
      }
    })
  }

  get(id: string): DshSessionFacade | undefined {
    return this.live.get(id)
  }

  attach(id: string, orchestrator: Orchestrator, createdAt: number): () => void {
    const existing = this.live.get(id)
    if (existing !== undefined) return () => {}
    const header = {
      id,
      createdAt,
      get cwd(): string | undefined {
        return orchestrator.state.allowedPaths[0]
      },
    }
    const target: DshSessionFacade = { header }
    const facade = new Proxy(target, {
      get(value, property, receiver) {
        if (typeof property === 'symbol' || property in value) return Reflect.get(value, property, receiver)
        throw new UnsupportedSessionCapabilityError(String(property))
      },
    })
    this.live.set(id, facade)
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      if (this.live.get(id) === facade) this.live.delete(id)
    }
  }
}

export const sessionStorePlugin = AiAgentSessionStore
export default AiAgentSessionStore
