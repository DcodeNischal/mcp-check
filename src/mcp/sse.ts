// Minimal Server-Sent Events parser over a byte stream, with a hard size cap.

export interface SseEvent {
  event: string
  data: string
  id?: string
}

export class SizeLimitError extends Error {
  constructor(limit: number) {
    super(`Response exceeded ${Math.round(limit / 1024)} KB`)
  }
}

/** Yields events as they arrive. Stops (throws) once more than `maxBytes` have been read. */
export async function* readSse(body: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  // Cancelling the reader ends a pending read immediately, which a generator .return() can't do.
  signal?.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let event = 'message'
  let data: string[] = []
  let id: string | undefined

  const flush = (): SseEvent | null => {
    if (!data.length) {
      event = 'message'
      return null
    }
    const out: SseEvent = { event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) }
    event = 'message'
    data = []
    return out
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new SizeLimitError(maxBytes)
      buffer += decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
        // A trailing "\r" may be the first half of "\r\n" split across chunks: wait for more.
        if (buffer[newline] === '\r' && newline === buffer.length - 1) break
        const line = buffer.slice(0, newline)
        const sepLength = buffer.startsWith('\r\n', newline) ? 2 : 1
        buffer = buffer.slice(newline + sepLength)

        if (line === '') {
          const out = flush()
          if (out) yield out
          continue
        }
        if (line.startsWith(':')) continue // comment / keep-alive
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value2 = colon < 0 ? '' : line.slice(colon + 1)
        if (value2.startsWith(' ')) value2 = value2.slice(1)
        if (field === 'event') event = value2
        else if (field === 'data') data.push(value2)
        else if (field === 'id') id = value2
      }
    }
    const last = flush()
    if (last) yield last
  } finally {
    reader.cancel().catch(() => {})
  }
}
