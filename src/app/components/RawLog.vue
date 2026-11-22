<template>
  <div class="space-y-6">
    <div v-if="steps.length">
      <h3 class="text-[11px] font-mono uppercase tracking-[0.25em] text-silver">How it connected</h3>
      <ol class="mt-3 space-y-1.5">
        <li v-for="(s, i) in steps" :key="i" class="font-mono text-xs text-silver break-words">
          <span class="text-white/80">{{ i + 1 }}. {{ attemptLabel[s.attempt] }}</span>
          <template v-if="s.status !== undefined"> · HTTP {{ s.status }}</template> · {{ s.outcome }}
        </li>
      </ol>
    </div>

    <div>
      <h3 class="text-[11px] font-mono uppercase tracking-[0.25em] text-silver">Messages <span class="text-white/60">{{ log.length }}</span></h3>
      <p class="mt-1 text-xs text-silver/80">Every HTTP exchange with the server, in order. Your token is never included.</p>
      <ul class="mt-3 space-y-2">
        <li v-for="(e, i) in log" :key="i" class="rounded-lg border border-white/10">
          <details>
            <summary class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 font-mono text-xs">
              <span class="text-silver">{{ e.method }}</span>
              <span class="text-white">{{ e.rpcMethod ?? pathOf(e.url) }}</span>
              <span :class="statusClass(e)">{{ e.error ? e.error : e.status !== undefined ? e.status : '—' }}</span>
              <span class="ml-auto text-silver">{{ e.ms }} ms</span>
            </summary>
            <div class="space-y-3 border-t border-white/10 px-4 py-3">
              <div v-if="e.requestBody">
                <p class="text-[11px] font-mono uppercase tracking-widest text-silver">Request</p>
                <pre class="mt-1 max-h-72 overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] text-white/85">{{ pretty(e.requestBody) }}</pre>
              </div>
              <div v-if="Object.keys(e.responseHeaders).length">
                <p class="text-[11px] font-mono uppercase tracking-widest text-silver">Response headers</p>
                <pre class="mt-1 max-h-40 overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] text-white/70">{{ headerText(e) }}</pre>
              </div>
              <div v-for="(m, j) in e.messages" :key="j">
                <p class="text-[11px] font-mono uppercase tracking-widest text-silver">Response{{ e.messages.length > 1 ? ` ${j + 1}` : '' }}</p>
                <pre class="mt-1 max-h-96 overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] text-white/85">{{ pretty(m) }}</pre>
              </div>
              <div v-if="e.rawText">
                <p class="text-[11px] font-mono uppercase tracking-widest text-silver">Response body (not JSON)</p>
                <pre class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-3 font-mono text-[11px] text-white/70">{{ e.rawText }}</pre>
              </div>
            </div>
          </details>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DetectionStep } from '../../mcp/client'
import type { Exchange } from '../api'

defineProps<{ log: Exchange[]; steps: DetectionStep[] }>()

const attemptLabel = { modern: 'Current spec (server/discover)', 'legacy-initialize': 'Previous spec (initialize)', 'sse-get': 'Deprecated HTTP+SSE (GET)' } as const

const pretty = (v: unknown) => JSON.stringify(v, null, 2)
const headerText = (e: Exchange) => Object.entries(e.responseHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname
  } catch {
    return u
  }
}
const statusClass = (e: Exchange) =>
  e.error || (e.status ?? 0) >= 500 ? 'text-rose-300' : (e.status ?? 0) >= 400 ? 'text-amber-300' : 'text-emerald-300'
</script>
