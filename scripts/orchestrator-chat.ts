import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { resolve } from 'node:path'
import { readdir, stat, mkdir } from 'node:fs/promises'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'

const stateDir = resolve(process.cwd(), 'state')

async function autoGenerateNextSessionId(): Promise<string> {
  await mkdir(stateDir, { recursive: true })
  const entries = await readdir(stateDir)
  const nums: number[] = []
  for (const entry of entries) {
    if (entry.startsWith('session-')) {
      const s = await stat(resolve(stateDir, entry))
      if (s.isDirectory()) {
        const numPart = entry.slice(8)
        const num = parseInt(numPart, 10)
        if (!Number.isNaN(num)) {
          nums.push(num)
        }
      }
    }
  }
  const nextNum = nums.length === 0 ? 1 : Math.max(...nums) + 1
  return `session-${String(nextNum).padStart(3, '0')}`
}

async function main() {
  let sessionId = process.argv[2]
  if (!sessionId) {
    sessionId = await autoGenerateNextSessionId()
    console.log(`[自动生成新会话] sessionId = ${sessionId}`)
  } else {
    console.log(`[加载/新建会话] sessionId = ${sessionId}`)
  }

  const orchestrator = await Orchestrator.load(sessionId)

  const rl = createInterface({ input: stdin, output: stdout })

  orchestrator.setAskConfirm(async (question: string) => {
    const answer = await rl.question(`${question} (y/n) `)
    return answer.trim().toLowerCase() === 'y'
  })

  orchestrator.setAskInput(async (question: string) => {
    return (await rl.question(question)).trim()
  })

  process.on('SIGINT', () => {
    rl.close()
    console.log('\nBye.')
    process.exit(0)
  })

  console.log('Orchestrator 测试启动。')
  console.log('- 输入普通聊天：Agent 直接对话')
  console.log('- 输入代码需求：Agent 自主分析需求、设计方案、生成代码')
  console.log('- 输入"设置目录"：修改可操作文件目录')
  console.log('- 输入"取消"：清除当前任务')
  console.log('- 输入 /exit 或按 Ctrl+C 退出')

  while (true) {
    const line = await rl.question('You> ')
    const prompt = line.trim()
    if (!prompt) continue
    if (prompt === '/exit') break

    await orchestrator.handleUserInput(prompt)
  }

  rl.close()
  console.log('Bye.')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
