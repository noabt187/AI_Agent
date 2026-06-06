export async function* parseSseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const onAbort = () => reader.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const idx = buffer.indexOf('\n')
        if (idx === -1) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const trimmed = line.trimEnd()
        if (trimmed) yield trimmed
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
