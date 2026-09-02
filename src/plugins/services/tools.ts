import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '../../llm/types.js'
import type { RepositoryConfig } from '../../orchestrator/types.js'
import {
  builtinToolRegistry,
  executeToolDefinition,
  toolEntriesToOpenAI,
  type ToolDef,
  type ToolScope,
} from '../../tools/index.js'

export interface ToolExecutionRequest {
  name: string
  args: Record<string, string>
  allowedPaths: string[]
  designConfirmed?: boolean
  signal?: AbortSignal
  turnLoadedSkills?: Set<string>
  repository?: RepositoryConfig
}

export interface AgentToolSource {
  definitions(scope: ToolScope): ToolDefinition[]
  execute(request: ToolExecutionRequest): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRegistry
  }
}

export class ToolRegistry extends Service implements AgentToolSource {
  private readonly entries = new Map<string, ToolDef>(Object.entries(builtinToolRegistry))

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(name: string, definition: ToolDef): () => void | Promise<void> {
    if (!name.trim()) throw new Error('ai-agent: tool name cannot be empty')
    return this.ctx.effect(() => {
      if (this.entries.has(name)) throw new Error(`ai-agent: duplicate tool ${JSON.stringify(name)}`)
      this.entries.set(name, definition)
      return () => {
        if (this.entries.get(name) === definition) this.entries.delete(name)
      }
    }, `tools.register(${name})`)
  }

  definitions(scope: ToolScope): ToolDefinition[] {
    return toolEntriesToOpenAI([...this.entries], scope)
  }

  async execute(request: ToolExecutionRequest): Promise<string> {
    const definition = this.entries.get(request.name)
    if (definition === undefined) return `错误：未知工具 "${request.name}"`
    return executeToolDefinition(
      definition,
      request.name,
      request.args,
      request.allowedPaths,
      request.designConfirmed,
      request.signal,
      { turnLoadedSkills: request.turnLoadedSkills, repository: request.repository },
    )
  }
}

export const toolRegistryPlugin = ToolRegistry
export default ToolRegistry
