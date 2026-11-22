// Tool quality: what an AI agent needs to pick the right tool and call it correctly.
import type { CheckResult, ToolSummary } from './types'

const NAME = /^[A-Za-z0-9_.-]{1,128}$/
const MIN_DESCRIPTION = 20
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

export function toolChecks(tools: ToolSummary[]): CheckResult[] {
  return [descriptions(tools), schemas(tools), paramDescriptions(tools), names(tools), annotations(tools), outputSchemas(tools), size(tools)]
}

function descriptions(tools: ToolSummary[]): CheckResult {
  const missing = tools.filter((t) => !t.description?.trim())
  const short = tools.filter((t) => t.description?.trim() && t.description.trim().length < MIN_DESCRIPTION)
  const base = { id: 'tools.descriptions', category: 'tools' as const, title: 'Every tool is described', weight: 3 }
  const fix = 'Give every tool a description that says what it does, when to use it, and what it returns.'
  if (!missing.length && !short.length) return { ...base, status: 'pass', detail: `All ${tools.length} tools have descriptions.` }
  if (missing.length > tools.length / 2) return { ...base, status: 'fail', detail: `${missing.length} of ${tools.length} tools have no description: ${list(missing)}.`, fix }
  return {
    ...base,
    status: 'warn',
    detail: [missing.length && `${missing.length} without a description (${list(missing)})`, short.length && `${short.length} with a very short one (${list(short)})`].filter(Boolean).join('; ') + '.',
    fix,
  }
}

/** Structural problems in a JSON Schema that would trip up clients or models. */
export function schemaProblems(schema: unknown, path = 'inputSchema', root = true): string[] {
  if (schema === undefined) return [`${path} is missing`]
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path} is not an object`]
  const s = schema as Record<string, unknown>
  const problems: string[] = []
  if (root && s.type !== 'object') problems.push(`${path}.type must be "object" (found ${JSON.stringify(s.type)})`)
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    for (const t of types) if (typeof t !== 'string' || !JSON_TYPES.has(t)) problems.push(`${path}.type ${JSON.stringify(t)} is not a JSON Schema type`)
  }
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) problems.push(`${path}.properties is not an object`)
    else for (const [key, sub] of Object.entries(s.properties)) problems.push(...schemaProblems(sub, `${path}.properties.${key}`, false))
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) problems.push(`${path}.required is not an array`)
    else {
      const props = s.properties && typeof s.properties === 'object' ? Object.keys(s.properties) : []
      for (const r of s.required) if (typeof r !== 'string' || (props.length && !props.includes(r))) problems.push(`${path}.required lists "${String(r)}", which isn't a property`)
    }
  }
  if (s.items !== undefined && !Array.isArray(s.items)) problems.push(...schemaProblems(s.items, `${path}.items`, false))
  return problems
}

function schemas(tools: ToolSummary[]): CheckResult {
  const broken = tools.map((t) => ({ t, problems: schemaProblems(t.inputSchema) })).filter((x) => x.problems.length)
  const base = { id: 'tools.schemas', category: 'tools' as const, title: 'Input schemas are valid', weight: 3 }
  if (!broken.length) return { ...base, status: 'pass', detail: `All ${tools.length} input schemas are valid JSON Schema objects.` }
  const sample = broken.slice(0, 3).map((x) => `${x.t.name}: ${x.problems[0]}`).join('; ')
  return {
    ...base,
    status: broken.length > tools.length / 2 ? 'fail' : 'warn',
    detail: `${broken.length} of ${tools.length} tools have schema problems. ${sample}${broken.length > 3 ? '; …' : ''}`,
    fix: 'Each inputSchema must be a JSON Schema with "type": "object" at the root; for no parameters use {"type":"object","additionalProperties":false}.',
  }
}

function paramDescriptions(tools: ToolSummary[]): CheckResult {
  let total = 0
  let described = 0
  const offenders = new Set<string>()
  for (const t of tools) {
    const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>
    if (!props || typeof props !== 'object') continue
    for (const p of Object.values(props)) {
      total++
      if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).description === 'string' && ((p as Record<string, unknown>).description as string).trim()) described++
      else offenders.add(t.name)
    }
  }
  const base = { id: 'tools.param-descriptions', category: 'tools' as const, title: 'Parameters are described', weight: 2 }
  if (total === 0) return { ...base, status: 'info', detail: 'No tool takes parameters.' }
  const ratio = described / total
  const detail = `${described} of ${total} parameters have descriptions.`
  if (ratio >= 0.9) return { ...base, status: 'pass', detail }
  return {
    ...base,
    status: ratio >= 0.5 ? 'warn' : 'fail',
    detail: `${detail} Missing in: ${[...offenders].slice(0, 5).join(', ')}${offenders.size > 5 ? ', …' : ''}.`,
    fix: 'Add a "description" to every property, with the format and an example ("City name, for example Kathmandu").',
  }
}

function names(tools: ToolSummary[]): CheckResult {
  const invalid = tools.filter((t) => !NAME.test(t.name))
  const seen = new Map<string, number>()
  for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1)
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name)
  const base = { id: 'tools.names', category: 'tools' as const, title: 'Tool names are valid and unique', weight: 2 }
  if (!invalid.length && !dupes.length) return { ...base, status: 'pass', detail: 'All names use A–Z, 0–9, _ - . and are unique.' }
  return {
    ...base,
    status: dupes.length ? 'fail' : 'warn',
    detail: [invalid.length && `Invalid names: ${invalid.map((t) => JSON.stringify(t.name)).slice(0, 5).join(', ')}`, dupes.length && `Duplicates: ${dupes.join(', ')}`].filter(Boolean).join('. ') + '.',
    fix: 'Use 1–128 characters from A–Z, a–z, 0–9, _, - and ., and give every tool a unique name.',
  }
}

function annotations(tools: ToolSummary[]): CheckResult {
  const annotated = tools.filter((t) => t.annotations && (typeof t.annotations.readOnlyHint === 'boolean' || typeof t.annotations.destructiveHint === 'boolean'))
  const base = { id: 'tools.annotations', category: 'tools' as const, title: 'Tools say whether they change things', weight: 2 }
  const detail = `${annotated.length} of ${tools.length} tools declare readOnlyHint or destructiveHint.`
  if (annotated.length === tools.length) return { ...base, status: 'pass', detail }
  return {
    ...base,
    status: 'warn',
    detail: `${detail} Without them, clients must assume every tool may be destructive and ask users to confirm each call.`,
    fix: 'Add annotations: { readOnlyHint: true } to tools that only read, and destructiveHint to tools that delete or overwrite.',
  }
}

function outputSchemas(tools: ToolSummary[]): CheckResult {
  const withOutput = tools.filter((t) => t.outputSchema !== undefined)
  const base = { id: 'tools.output-schema', category: 'tools' as const, title: 'Output schemas are valid', weight: 1 }
  if (!withOutput.length) return { ...base, status: 'info', detail: 'No tool declares an outputSchema (optional; it helps clients use structured results).' }
  const broken = withOutput.filter((t) => schemaProblems(t.outputSchema, 'outputSchema', false).length)
  if (!broken.length) return { ...base, status: 'pass', detail: withOutput.length === 1 ? '1 tool declares a valid outputSchema.' : `${withOutput.length} tools declare a valid outputSchema.` }
  return { ...base, status: 'warn', detail: `Invalid outputSchema in: ${list(broken)}.`, fix: 'Make each outputSchema a valid JSON Schema.' }
}

function size(tools: ToolSummary[]): CheckResult {
  const bytes = new TextEncoder().encode(JSON.stringify(tools)).byteLength
  const kb = Math.round(bytes / 1024)
  const tokens = Math.round(bytes / 4)
  const base = { id: 'tools.size', category: 'tools' as const, title: 'Tool list fits in an agent\'s context', weight: 1 }
  const detail = `The tool definitions are about ${kb} KB (roughly ${tokens.toLocaleString('en-US')} tokens), loaded into every conversation that uses this server.`
  if (bytes <= 30 * 1024) return { ...base, status: 'pass', detail }
  return {
    ...base,
    status: bytes <= 100 * 1024 ? 'warn' : 'fail',
    detail,
    fix: 'Trim long descriptions, merge overlapping tools, or split rarely used tools into a separate server.',
  }
}

function list(tools: ToolSummary[]): string {
  const names = tools.map((t) => t.name)
  return names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '')
}
