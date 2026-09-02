import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createFileAgentSkillSource, type AgentSkillSource } from '../skills/index.js'
import { executeTool, toolDefsToOpenAI } from '../tools/index.js'
import { createAgentSkillSource } from '../plugins/services/skills.js'
import type { AgentToolSource, ToolExecutionRequest } from '../plugins/services/tools.js'

export interface AgentRuntime {
  skills: AgentSkillSource
  tools: AgentToolSource
}

const SKILLS_DIR = resolve(import.meta.dirname ?? process.cwd(), '../skills')

const legacyTools: AgentToolSource = {
  definitions: toolDefsToOpenAI,
  execute(request: ToolExecutionRequest) {
    return executeTool(
      request.name,
      request.args,
      request.allowedPaths,
      request.designConfirmed,
      request.signal,
      { turnLoadedSkills: request.turnLoadedSkills, repository: request.repository },
    )
  },
}

export const legacyAgentRuntime: AgentRuntime = {
  skills: createFileAgentSkillSource(SKILLS_DIR),
  tools: legacyTools,
}

export function createCordisAgentRuntime(ctx: Context): AgentRuntime {
  return {
    skills: createAgentSkillSource(ctx.skills),
    tools: ctx.tools,
  }
}
