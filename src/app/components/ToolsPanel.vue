<template>
  <div>
    <p v-if="!tools.length" class="text-sm text-silver">No tools to show.</p>
    <ul v-else class="space-y-3">
      <li v-for="t in tools" :key="t.name" class="rounded-xl border border-white/10 bg-white/[0.02]">
        <div class="px-5 py-4">
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-mono text-sm text-white break-all">{{ t.name }}</p>
            <span v-if="t.title" class="text-sm text-silver">· {{ t.title }}</span>
            <span v-if="isReadOnly(t)" class="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-emerald-300">Read-only</span>
            <span v-else-if="isDestructive(t)" class="rounded-full bg-rose-400/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-rose-300">{{ t.annotations ? 'Destructive' : 'May change data' }}</span>
          </div>
          <p v-if="t.description" class="mt-2 whitespace-pre-line text-sm leading-relaxed text-silver break-words">{{ t.description }}</p>

          <ul v-if="paramsOf(t).length" class="mt-3 space-y-1">
            <li v-for="p in paramsOf(t)" :key="p.key" class="text-xs text-silver break-words">
              <span class="font-mono text-white/90">{{ p.key }}</span><span v-if="p.required" class="text-rose-300">*</span>
              <span class="font-mono text-silver/70"> {{ p.type }}</span><template v-if="p.description"> · {{ p.description }}</template>
            </li>
          </ul>

          <button type="button" class="mt-4 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5 cursor-pointer" @click="open = open === t.name ? '' : t.name">
            {{ open === t.name ? 'Close' : 'Try it' }}
          </button>
        </div>

        <!-- Runner -->
        <form v-if="open === t.name" class="border-t border-white/10 px-5 py-4 space-y-3" @submit.prevent="run(t)">
          <div class="flex justify-end">
            <button type="button" class="text-xs text-silver hover:text-white cursor-pointer" @click="toggleJson(t)">{{ jsonMode ? 'Use form' : 'Edit as JSON' }}</button>
          </div>
          <textarea v-if="jsonMode" v-model="jsonText" rows="6" spellcheck="false" aria-label="Arguments as JSON"
                    class="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs focus:border-white/40 focus:outline-none"></textarea>
          <template v-else>
            <p v-if="!paramsOf(t).length" class="text-xs text-silver">This tool takes no arguments.</p>
            <label v-for="p in paramsOf(t)" :key="p.key" class="block">
              <span class="text-xs text-silver"><span class="font-mono text-white/90">{{ p.key }}</span><span v-if="p.required" class="text-rose-300">*</span> <span class="font-mono text-silver/60">{{ p.type }}</span></span>
              <select v-if="p.enum" v-model="values[p.key]" class="mt-1 w-full rounded-lg border border-white/15 bg-black px-3 py-2 text-sm">
                <option value="">—</option>
                <option v-for="opt in p.enum" :key="String(opt)" :value="String(opt)">{{ opt }}</option>
              </select>
              <input v-else-if="p.type === 'boolean'" v-model="values[p.key]" type="checkbox" class="mt-2 block h-4 w-4" />
              <textarea v-else-if="p.type === 'object' || p.type === 'array' || p.type === 'any'" v-model="values[p.key]" rows="3" spellcheck="false" placeholder="JSON"
                        class="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs focus:border-white/40 focus:outline-none"></textarea>
              <input v-else v-model="values[p.key]" :type="p.type === 'number' || p.type === 'integer' ? 'number' : 'text'" :step="p.type === 'integer' ? 1 : 'any'" spellcheck="false"
                     class="mt-1 w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm focus:border-white/40 focus:outline-none" />
            </label>
          </template>

          <label v-if="!isReadOnly(t)" class="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-200">
            <input v-model="confirmed" type="checkbox" class="mt-0.5" />
            <span>This runs against the real server and may change data there. I understand.</span>
          </label>

          <div ref="turnstileEl" class="empty:hidden"></div>
          <button type="submit" :disabled="running || (!isReadOnly(t) && !confirmed)"
                  class="rounded-lg bg-white px-4 py-2 text-sm text-black disabled:opacity-50 cursor-pointer">{{ running ? 'Running…' : 'Run tool' }}</button>
          <p v-if="runError" role="alert" class="text-sm text-rose-300">{{ runError }}</p>

          <!-- Result -->
          <div v-if="outcome" class="space-y-2" aria-live="polite">
            <p class="text-xs font-mono text-silver">
              <span :class="outcome.ok && !outcome.result?.isError ? 'text-emerald-300' : 'text-rose-300'">{{ outcome.ok ? (outcome.result?.isError ? 'Tool returned an error' : 'Success') : 'Failed' }}</span>
              <template v-if="outcome.ms !== undefined"> · {{ outcome.ms }} ms</template>
            </p>
            <p v-if="outcome.error" class="text-sm text-rose-300 break-words">{{ outcome.error.code !== undefined ? `${outcome.error.code}: ` : '' }}{{ outcome.error.message }}</p>
            <template v-for="(block, i) in contentOf(outcome)" :key="i">
              <img v-if="block.kind === 'image'" :src="block.src" alt="Image returned by the tool" class="max-h-80 rounded-lg border border-white/10" />
              <pre v-else class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-white/90">{{ block.text }}</pre>
            </template>
          </div>
        </form>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { ToolSummary } from '../../checks/types'
import { ApiError, callTool, type CallOutcome, type Target } from '../api'
import { useTurnstile } from '../turnstile'

const props = defineProps<{ tools: ToolSummary[]; target: Target }>()

const open = ref('')
const jsonMode = ref(false)
const jsonText = ref('{}')
// Form inputs: strings for text fields, booleans for checkboxes (v-model binds both).
const values = reactive<Record<string, any>>({})
const confirmed = ref(false)
const running = ref(false)
const runError = ref('')
const outcome = ref<CallOutcome | null>(null)
const { el: turnstileEl, getToken, reset } = useTurnstile('call')

interface Param { key: string; type: string; required: boolean; description?: string; enum?: unknown[] }

const isReadOnly = (t: ToolSummary) => t.annotations?.readOnlyHint === true
// Per the spec, a tool is assumed destructive unless it says otherwise.
const isDestructive = (t: ToolSummary) => !isReadOnly(t) && t.annotations?.destructiveHint !== false

function paramsOf(t: ToolSummary): Param[] {
  const schema = (t.inputSchema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: unknown }
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.entries(schema.properties ?? {}).map(([key, s]) => ({
    key,
    type: Array.isArray(s?.type) ? String(s.type.find((x) => x !== 'null') ?? 'any') : typeof s?.type === 'string' ? s.type : 'any',
    required: required.includes(key),
    ...(typeof s?.description === 'string' ? { description: s.description } : {}),
    ...(Array.isArray(s?.enum) ? { enum: s.enum } : {}),
  }))
}

function buildArgs(t: ToolSummary): Record<string, unknown> {
  if (jsonMode.value) {
    const parsed = JSON.parse(jsonText.value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object.')
    return parsed
  }
  const args: Record<string, unknown> = {}
  for (const p of paramsOf(t)) {
    const v = values[p.key]
    if (p.type === 'boolean') {
      if (v !== undefined) args[p.key] = !!v
      continue
    }
    if (v === undefined || v === '') {
      if (p.required) throw new Error(`"${p.key}" is required.`)
      continue
    }
    if (p.type === 'number' || p.type === 'integer') args[p.key] = Number(v)
    else if (p.type === 'object' || p.type === 'array' || p.type === 'any') {
      try {
        args[p.key] = JSON.parse(String(v))
      } catch {
        if (p.type === 'any') args[p.key] = v
        else throw new Error(`"${p.key}" must be valid JSON.`)
      }
    } else args[p.key] = v
  }
  return args
}

function toggleJson(t: ToolSummary) {
  if (!jsonMode.value) {
    try {
      jsonText.value = JSON.stringify(buildArgs(t), null, 2)
    } catch {
      jsonText.value = '{}'
    }
  }
  jsonMode.value = !jsonMode.value
}

async function run(t: ToolSummary) {
  runError.value = ''
  outcome.value = null
  let args: Record<string, unknown>
  try {
    args = buildArgs(t)
  } catch (err) {
    runError.value = err instanceof Error ? err.message : 'Invalid arguments.'
    return
  }
  running.value = true
  try {
    outcome.value = await callTool(props.target, t.name, args, await getToken())
  } catch (err) {
    runError.value = err instanceof ApiError ? err.message : 'Something went wrong.'
  } finally {
    running.value = false
    reset()
  }
}

type Block = { kind: 'text'; text: string } | { kind: 'image'; src: string }

/** Render the tool's content blocks as text or images (only base64 image/* data URLs). */
function contentOf(o: CallOutcome): Block[] {
  const result = o.result
  if (!result) return []
  const blocks: Block[] = []
  const content = Array.isArray(result.content) ? result.content : []
  for (const c of content as Record<string, unknown>[]) {
    if (c?.type === 'text' && typeof c.text === 'string') blocks.push({ kind: 'text', text: c.text })
    else if (c?.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType) && c.data.length < 4_000_000) {
      blocks.push({ kind: 'image', src: `data:${c.mimeType};base64,${c.data}` })
    } else blocks.push({ kind: 'text', text: JSON.stringify(c, null, 2) })
  }
  if (result.structuredContent !== undefined) blocks.push({ kind: 'text', text: `structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}` })
  if (!blocks.length) blocks.push({ kind: 'text', text: JSON.stringify(result, null, 2) })
  return blocks
}
</script>
