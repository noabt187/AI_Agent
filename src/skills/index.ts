import type { WorldState } from '../orchestrator/types.js'
import { loadEnabledSkills } from './registry.js'

export type Skill = {
  name: string
  trigger: string
  description?: string
  summary?: string
  node?: string
  entry?: string
  onConfirmNext?: string
  onAllowWriteNext?: string
  insertAfter?: string
  insertBefore?: string
  priority?: number
  content: string
}

export type WorkflowSnapshot = {
  node: string
  intent: 'development' | 'repository' | 'pull_request' | 'chat'
  writeAllowed: boolean
  hasPendingConfirm: boolean
  hasConfirmedInput: boolean
  hasPlannedWork: boolean
  userInput: string
  goal?: string
}

export type SelectedSkills = {
  primary?: Skill
  details: Skill[]
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  return loadEnabledSkills(skillsDir)
}

const NEGATION_BEFORE_RE = /(?:不要|不用|无需|不需要|不想|不打算|不做|不提|不提交|不创建|不发起|不是|不|别|禁止|先不|暂不|no|not|don't|do not|without)\s*$/i
const LIST_NEGATION_BEFORE_RE = /(?:不要|不用|无需|不需要|不想|不打算|不做|别|禁止|先不|暂不)\s*(?:fork|clone|pr|pull\s*request|克隆|提\s*pr|提交\s*pr|创建\s*pr|发起\s*pr)?\s*(?:、|\/|或|和|及|,|，)\s*$/i

function hasNonNegatedMatch(input: string, pattern: RegExp): boolean {
  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0
    const before = input.slice(Math.max(0, index - 18), index)
    if (!NEGATION_BEFORE_RE.test(before) && !LIST_NEGATION_BEFORE_RE.test(before)) return true
  }
  return false
}

function matchesRepositoryRequest(input: string): boolean {
  return hasNonNegatedMatch(input, /\b(?:fork|clone)\b|克隆|创建\s*fork|新建\s*fork/gi)
}

function matchesPullRequest(input: string): boolean {
  return hasNonNegatedMatch(
    input,
    /(?:^|\s)\/pr\b|(?:提|提交|创建|发起|新建|开)\s*(?:一个|个)?\s*(?:pr|pull\s*request)\b|(?:pr|pull\s*request)\s*(?:到|给|一下|吧|上)/gi,
  )
}

function inferIntent(input: string): WorkflowSnapshot['intent'] {
  if (matchesPullRequest(input)) return 'pull_request'
  if (matchesRepositoryRequest(input)) return 'repository'
  return input.trim() ? 'development' : 'chat'
}

export function buildWorkflowSnapshot(state: WorldState, userInput: string): WorkflowSnapshot {
  const requestText = `${state.goal ?? ''}\n${userInput}`
  const writeAllowed = !!state.designConfirmed
  const hasConfirmedInput = !!state.confirmedRequirement
  const node = state.workflow?.node
    || (writeAllowed ? 'code-generation' : hasConfirmedInput ? 'solution-design' : 'requirement-analysis')

  return {
    node,
    intent: inferIntent(requestText),
    writeAllowed,
    hasPendingConfirm: !!state.pendingConfirm,
    hasConfirmedInput,
    hasPlannedWork: !!state.designTasks?.length,
    userInput,
    goal: state.goal,
  }
}

function skillNode(skill: Skill): string | undefined {
  if (skill.node) return skill.node
  if (skill.trigger === 'has_goal_no_requirement') return 'requirement-analysis'
  if (skill.trigger === 'has_requirement_no_tasks') return 'solution-design'
  if (skill.trigger === 'has_tasks') return 'code-generation'
  return undefined
}

function skillEntry(skill: Skill): string | undefined {
  if (skill.entry) return skill.entry
  if (skill.trigger === 'pull_request_request' || skill.trigger === 'repository_request') return skill.trigger
  return undefined
}

function byPriority(a: Skill, b: Skill): number {
  return (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name)
}

function findSkill(skills: Skill[], predicate: (skill: Skill) => boolean): Skill | undefined {
  return [...skills].sort(byPriority).find(predicate)
}

function summarizeSkill(skill: Skill): string {
  return `- ${skill.name}: ${skill.summary || skill.description || skillNode(skill) || skillEntry(skill) || skill.trigger}`
}

function findLifecycleSkill(skills: Skill[], snapshot: WorkflowSnapshot): Skill | undefined {
  if (snapshot.writeAllowed) return findSkill(skills, (skill) => skillNode(skill) === 'code-generation')
  if (snapshot.hasConfirmedInput) return findSkill(skills, (skill) => skillNode(skill) === 'solution-design')
  return findSkill(skills, (skill) => skillNode(skill) === 'requirement-analysis')
}

export function resolveNextNode(currentNode: string, defaultNext: string | undefined, skills: Skill[]): string | undefined {
  if (!defaultNext) return undefined
  const inserted = findSkill(skills, (skill) => skill.insertAfter === currentNode && skill.insertBefore === defaultNext)
  return inserted ? (skillNode(inserted) || inserted.name) : defaultNext
}

export function selectActiveSkills(skills: Skill[], snapshot: WorkflowSnapshot): SelectedSkills {
  let primary: Skill | undefined
  if (snapshot.intent === 'pull_request') {
    primary = findSkill(skills, (skill) => skillEntry(skill) === 'pull_request_request' || skill.name === 'pull-request')
  } else if (snapshot.intent === 'repository') {
    primary = findSkill(skills, (skill) => skillEntry(skill) === 'repository_request' || skill.name === 'repository-tools')
  } else {
    primary = findSkill(skills, (skill) => skillNode(skill) === snapshot.node)
      || findLifecycleSkill(skills, snapshot)
  }

  const lifecycleSkill = snapshot.intent === 'development' ? findLifecycleSkill(skills, snapshot) : undefined
  const details = primary ? [primary] : []
  if (lifecycleSkill && primary && lifecycleSkill.name !== primary.name) details.push(lifecycleSkill)

  return { primary, details: details.slice(0, 2) }
}

export function formatSkillContext(skills: Skill[], selection: SelectedSkills): string {
  const indexText = [...skills].sort(byPriority).map(summarizeSkill).join('\n')
  const detailText = selection.details.map((skill) => `### ${skill.name}\n${skill.content}`).join('\n\n')
  const parts = [`## Skill Index\n${indexText || '（无）'}`]
  if (detailText.trim()) {
    parts.push(`## Active Skill Details\n${detailText}`)
  }
  return parts.join('\n\n')
}

export function getActiveSkills(skills: Skill[], state: WorldState, userInput = ''): Skill[] {
  return selectActiveSkills(skills, buildWorkflowSnapshot(state, userInput)).details
}
