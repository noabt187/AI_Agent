import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exec } from 'node:child_process'
import { collectFiles } from '../utils/fileUtils.js'

async function verifyCodeTool(rootDir: string, changedFiles: string): Promise<string> {
  const results: string[] = []
  let hasError = false

  // ── 1. 读取 package.json，检测可用命令 ──
  const scripts: Record<string, string> = {}
  try {
    const pkgRaw = await readFile(resolve(rootDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    Object.assign(scripts, pkg.scripts || {})
  } catch {}

  // 检查是否有子项目的 package.json（前后端分离项目）
  const subDirs = ['backend', 'frontend']
  const subScripts: Record<string, Record<string, string>> = {}
  for (const sub of subDirs) {
    try {
      const subPkgRaw = await readFile(resolve(rootDir, sub, 'package.json'), 'utf8')
      const subPkg = JSON.parse(subPkgRaw)
      subScripts[sub] = subPkg.scripts || {}
    } catch {}
  }

  // ── 2. 运行可用的验证命令 ──
  const runCmd = (cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> => {
    return new Promise((r) => {
      exec(cmd, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        r({ ok: !err, output: output.slice(0, 2000) })
      })
    })
  }

  // 根目录 test
  if (scripts.test) {
    const { ok, output } = await runCmd('npm test -- --run', rootDir)
    if (!ok) {
      hasError = true
      results.push(`❌ 根目录 npm test 失败:\n${output}`)
    } else {
      results.push(`✅ 根目录 npm test 通过`)
    }
  }

  // 根目录 build
  if (scripts.build) {
    const { ok, output } = await runCmd('npm run build', rootDir)
    if (!ok) {
      hasError = true
      results.push(`❌ 根目录 npm run build 失败:\n${output}`)
    } else {
      results.push(`✅ 根目录 npm run build 通过`)
    }
  }

  // 子项目 lint/test/build
  for (const [dir, sc] of Object.entries(subScripts)) {
    if (sc.lint) {
      const { ok, output } = await runCmd('npm run lint', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm run lint 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm run lint 通过`)
      }
    }
    if (sc.test) {
      const { ok, output } = await runCmd('npm test', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm test 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm test 通过`)
      }
    }
    if (sc.build) {
      const { ok, output } = await runCmd('npm run build', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm run build 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm run build 通过`)
      }
    }
  }

  // ── 3. 跨栈一致性检查 ──
  const files = changedFiles.split(',').map((f) => f.trim()).filter(Boolean)
  const backendModelFiles = files.filter((f) => /models?\//i.test(f) && /backend/i.test(f))
  const backendControllerFiles = files.filter((f) => /controllers?\//i.test(f) && /backend/i.test(f))

  if (backendModelFiles.length > 0 || backendControllerFiles.length > 0) {
    const backendFields: string[] = []
    for (const modelFile of backendModelFiles) {
      try {
        const content = await readFile(resolve(rootDir, modelFile), 'utf8')
        const fieldMatches = content.matchAll(/^\s+(\w+)\s*:/gm)
        for (const m of fieldMatches) {
          const field = m[1]
          if (['id', 'createdAt', 'updatedAt', 'associate', 'toJSON', 'init', 'type', 'defaultValue', 'allowNull', 'primaryKey', 'autoIncrement', 'unique'].includes(field)) continue
          if (field.startsWith('_')) continue
          backendFields.push(field)
        }
      } catch {}
    }

    if (backendFields.length > 0) {
      const frontendDir = resolve(rootDir, 'frontend', 'src')
      for (const field of backendFields) {
        try {
          const allFrontendFiles = await collectFiles(frontendDir)
          let found = false
          for (const f of allFrontendFiles) {
            try {
              const content = await readFile(resolve(frontendDir, f), 'utf8')
              if (content.includes(field)) {
                found = true
                break
              }
            } catch {}
          }
          if (!found) {
            results.push(`⚠️ 跨栈一致性: 后端字段 "${field}" 在前端代码中未找到引用，可能需要同步修改前端`)
          }
        } catch {}
      }
      if (backendFields.length > 0 && !results.some((r) => r.includes('⚠️'))) {
        results.push(`✅ 跨栈一致性检查通过（后端字段: ${backendFields.join(', ')}）`)
      }
    }
  }

  if (backendModelFiles.length === 0 && backendControllerFiles.length === 0) {
    results.push(`ℹ️ 本次修改未涉及后端模型/控制器，跳过跨栈一致性检查`)
  }

  // ── 4. 汇总 ──
  const summary = hasError ? '❌ 验证未通过' : '✅ 验证通过'
  return `${summary}\n\n${results.join('\n')}`
}

export { verifyCodeTool }
