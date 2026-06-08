import {
  isMemoryType,
  saveMemory,
  type MemoryLayerId,
  type MemoryType,
} from '../memory/projectMemory.js'

const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GENERIC_MEMORY_RE = /^(done|fixed|updated|task-complete|完成|完成了任务|任务完成|修改了代码|运行了测试)[。.!]*$/i

function normalizeText(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} is required`)
  return trimmed
}

function normalizeLayer(value: string): Extract<MemoryLayerId, 'project' | 'global'> {
  if (value === 'project' || value === 'global') return value
  throw new Error('writeMemory only supports project or global layer')
}

function normalizeType(value: string): MemoryType {
  if (isMemoryType(value)) return value
  throw new Error('type must be user, feedback, project, or reference')
}

function requireUsefulMemory(description: string, body: string, type: MemoryType): void {
  if (GENERIC_MEMORY_RE.test(description) || GENERIC_MEMORY_RE.test(body)) {
    throw new Error('memory is too generic; skip temporary task summaries')
  }

  if (type === 'project' || type === 'feedback') {
    if (!/^Why:/im.test(body) || !/^How to apply:/im.test(body)) {
      throw new Error('project and feedback memories must include Why: and How to apply:')
    }
  }
}

export async function writeMemoryTool(
  rootDir: string,
  layerValue: string,
  nameValue: string,
  descriptionValue: string,
  typeValue: string,
  bodyValue: string,
): Promise<string> {
  const layer = normalizeLayer(layerValue)
  const name = normalizeText(nameValue, 'name')
  if (!KEBAB_NAME_RE.test(name)) {
    throw new Error('name must be short kebab-case, for example cross-stack-update-field')
  }

  const description = normalizeText(descriptionValue, 'description')
  if (description.includes('\n')) throw new Error('description must be one line')

  const type = normalizeType(typeValue)
  const body = normalizeText(bodyValue, 'body')
  requireUsefulMemory(description, body, type)

  const { memory, created } = await saveMemory({
    layer,
    projectDir: rootDir,
    name,
    description,
    type,
    body,
  })

  return `[memory] ${created ? 'created' : 'updated'} ${layer}:${memory.name}\n${memory.filePath}`
}
