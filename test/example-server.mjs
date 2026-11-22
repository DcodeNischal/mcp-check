// A small MCP server (Streamable HTTP, 2025-11-25) with no dependencies, used by CI to run the
// GitHub Action end to end. Usage: node test/example-server.mjs [port]
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 3000)
const VERSION = '2025-11-25'
const tools = [
  {
    name: 'add',
    title: 'Add numbers',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number', description: 'The first number.' }, b: { type: 'number', description: 'The second number.' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
]

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: VERSION, capabilities: { tools: {} }, serverInfo: { name: 'example', title: 'Example server', version: '1.0.0' } })
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools })
    case 'tools/call': {
      if (params?.name !== 'add') return error(id, -32602, `Unknown tool: ${params?.name}`)
      const { a, b } = params.arguments ?? {}
      if (typeof a !== 'number' || typeof b !== 'number') return result(id, { content: [{ type: 'text', text: 'a and b must be numbers.' }], isError: true })
      return result(id, { content: [{ type: 'text', text: String(a + b) }] })
    }
    default:
      return error(id, -32601, `Method not found: ${method}`)
  }
}

createServer(async (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/mcp') return res.writeHead(404).end()
  // Only local pages may call this server from a browser.
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.writeHead(403).end('Forbidden origin')
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end()

  let body = ''
  for await (const chunk of req) body += chunk
  let msg
  try {
    msg = JSON.parse(body)
  } catch {
    return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(error(null, -32700, 'Parse error')))
  }
  if (msg.id === undefined) return res.writeHead(202).end() // a notification
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handle(msg)))
}).listen(port, () => console.log(`example MCP server on http://localhost:${port}/mcp`))
