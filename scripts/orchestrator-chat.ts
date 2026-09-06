import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { resolve } from 'node:path'
import { readdir, stat, mkdir } from 'node:fs/promises'
import { emitKeypressEvents } from 'node:readline'
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

  // ESC key → abort current agent operation
  emitKeypressEvents(stdin)
  if (stdin.isTTY) {
    stdin.setRawMode(true)
    stdin.on('keypress', (_str, key) => {
      if (key && key.name === 'escape') {
        orchestrator.abort()
        console.log('\n[中断] 正在停止当前操作...')
      }
    })
  }

  console.log('Orchestrator 测试启动。')
  console.log('- 输入普通聊天：Agent 直接对话')
  console.log('- 输入代码需求：Agent 自主分析需求、设计方案、生成代码')
  console.log('- 输入"设置目录"：修改可操作文件目录')
  console.log('- 输入"取消"：清除当前任务')
  console.log('- 输入 /revert <项目路径> <GitHub仓库地址>：回退项目代码到 GitHub 版本')
  console.log('- 输入 /memory auto|off|on|list|forget <id>：查看或设置记忆召回')
  console.log('- 输入 /remember <内容>：保存项目固定记忆')
  console.log('- 按 ESC 中断当前操作')
  console.log('- 输入 /exit 或按 Ctrl+C 退出')

  while (true) {
    const line = await rl.question('You> ')
    const prompt = line.trim()
    if (!prompt) continue
    if (prompt === '/exit') break

    try {
      // handleUserInput binds synchronously at entry, including CLI-generated
      // run/message IDs, and finalizes the same task before the next question.
      await orchestrator.handleUserInput(prompt)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') console.log('[已暂停] 输入“继续”恢复当前任务，或发送新请求。')
      else console.error(error instanceof Error ? error.message : String(error))
    }
  }

  rl.close()
  console.log('Bye.')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
