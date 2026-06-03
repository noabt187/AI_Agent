import { maybeCompressContext, estimateTokenCount } from '../context/contextCompressor.js'
import { loadMessages } from '../state/sessionStore.js'

export async function compressContextTool(rootDir: string, sessionId: string): Promise<string> {
  // rootDir 在此工具中不使用，sessionId 从参数获取
  const messages = await loadMessages(sessionId)
  const tokensBefore = estimateTokenCount(messages)

  const compressed = await maybeCompressContext(sessionId)

  if (!compressed) {
    return `上下文无需压缩（当前约 ${tokensBefore} tokens）`
  }

  const messagesAfter = await loadMessages(sessionId)
  const tokensAfter = estimateTokenCount(messagesAfter)

  return `上下文压缩完成：${tokensBefore} tokens → ${tokensAfter} tokens`
}
