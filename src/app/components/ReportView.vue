<template>
  <section class="mt-12" aria-labelledby="report-title">
    <!-- Summary -->
    <div class="flex flex-col md:flex-row gap-6 md:items-center rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:p-8">
      <div class="flex items-center gap-5">
        <div class="grid h-20 w-20 shrink-0 place-items-center rounded-2xl text-5xl font-medium" :class="gradeStyle" aria-hidden="true">{{ report.grade }}</div>
        <div class="min-w-0">
          <h2 id="report-title" class="text-2xl font-light tracking-tight break-words">
            {{ report.serverInfo?.title || report.serverInfo?.name || hostname }}
            <span v-if="report.serverInfo?.version" class="ml-1 font-mono text-sm text-silver">{{ report.serverInfo.version }}</span>
          </h2>
          <p class="mt-1 font-mono text-xs text-silver break-all">{{ report.url }}</p>
          <p class="mt-2 text-sm text-silver">
            <span class="sr-only">Grade {{ report.grade }}, </span>Score {{ report.score }}/100
            <template v-if="report.partial"> · <span class="text-amber-300">Partial grade: sign in to grade its tools</span></template>
            <template v-if="report.gradeCap"> · <span class="text-amber-300">Held at B: fails “{{ report.gradeCap }}”</span></template>
          </p>
        </div>
      </div>
      <dl class="md:ml-auto grid grid-cols-3 gap-6 text-sm">
        <div><dt class="text-[11px] font-mono uppercase tracking-widest text-silver">Spec</dt><dd class="mt-1">{{ report.version ?? '—' }}</dd></div>
        <div><dt class="text-[11px] font-mono uppercase tracking-widest text-silver">Transport</dt><dd class="mt-1">{{ eraLabel }}</dd></div>
        <div><dt class="text-[11px] font-mono uppercase tracking-widest text-silver">Tools</dt><dd class="mt-1">{{ report.connected ? report.tools.length : '—' }}</dd></div>
      </dl>
    </div>

    <div v-if="$slots.actions" class="mt-4"><slot name="actions" /></div>

    <p v-if="report.error" role="alert" class="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/[0.06] px-5 py-4 text-sm text-rose-200">{{ report.error }}</p>

    <!-- Tabs -->
    <div role="tablist" aria-label="Report sections" class="mt-8 flex gap-1 overflow-x-auto border-b border-white/10">
      <button v-for="t in tabs" :id="`tab-${t.id}`" :key="t.id" role="tab" type="button" :aria-selected="tab === t.id" :aria-controls="`panel-${t.id}`"
              class="-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition cursor-pointer"
              :class="tab === t.id ? 'border-white text-white' : 'border-transparent text-silver hover:text-white'"
              @click="tab = t.id">
        {{ t.label }}<span v-if="t.count !== undefined" class="ml-1.5 font-mono text-xs text-silver">{{ t.count }}</span>
      </button>
    </div>

    <div v-show="tab === 'checks'" id="panel-checks" role="tabpanel" aria-labelledby="tab-checks" class="mt-6 space-y-8">
      <div v-for="group in groups" :key="group.category">
        <h3 class="text-[11px] font-mono uppercase tracking-[0.25em] text-silver">{{ group.label }}</h3>
        <ul class="mt-3 divide-y divide-white/5 rounded-xl border border-white/10">
          <li v-for="c in group.checks" :key="c.id" class="flex gap-4 px-5 py-4">
            <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold" :class="statusStyle[c.status]" :aria-label="c.status">{{ statusIcon[c.status] }}</span>
            <div class="min-w-0">
              <p class="text-sm text-white">{{ c.title }}</p>
              <p class="mt-1 text-sm leading-relaxed text-silver break-words">{{ c.detail }}</p>
              <p v-if="c.fix" class="mt-2 text-sm leading-relaxed text-white/80"><span class="font-mono text-[11px] uppercase tracking-widest text-emerald-300">Fix</span> {{ c.fix }}</p>
            </div>
          </li>
        </ul>
      </div>
      <p class="text-xs text-silver/80">Checked in {{ (report.durationMs / 1000).toFixed(1) }}s · {{ new Date(report.checkedAt).toLocaleString() }}</p>
    </div>

    <div v-show="tab === 'tools'" id="panel-tools" role="tabpanel" aria-labelledby="tab-tools" class="mt-6">
      <ToolsPanel :tools="report.tools" :target="target" />
    </div>

    <div v-show="tab === 'more'" id="panel-more" role="tabpanel" aria-labelledby="tab-more" class="mt-6 space-y-8">
      <div v-for="section in moreSections" :key="section.title">
        <h3 class="text-[11px] font-mono uppercase tracking-[0.25em] text-silver">{{ section.title }} <span class="text-white/60">{{ section.items.length }}</span></h3>
        <p v-if="!section.items.length" class="mt-3 text-sm text-silver">None.</p>
        <ul v-else class="mt-3 divide-y divide-white/5 rounded-xl border border-white/10">
          <li v-for="item in section.items" :key="item.key" class="px-5 py-3">
            <p class="font-mono text-sm text-white break-all">{{ item.key }}</p>
            <p v-if="item.description" class="mt-1 text-sm text-silver">{{ item.description }}</p>
          </li>
        </ul>
      </div>
      <div v-if="report.instructions">
        <h3 class="text-[11px] font-mono uppercase tracking-[0.25em] text-silver">Server instructions</h3>
        <p class="mt-3 whitespace-pre-line rounded-xl border border-white/10 px-5 py-4 text-sm text-silver">{{ report.instructions }}</p>
      </div>
    </div>

    <div v-show="tab === 'log'" id="panel-log" role="tabpanel" aria-labelledby="tab-log" class="mt-6">
      <RawLog :log="log" :steps="report.steps" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Exchange, Report, Target } from '../api'
import RawLog from './RawLog.vue'
import ToolsPanel from './ToolsPanel.vue'

const props = withDefaults(defineProps<{ report: Report; log?: Exchange[]; target: Target }>(), { log: () => [] })
const tab = ref<'checks' | 'tools' | 'more' | 'log'>('checks')

const hostname = computed(() => {
  try {
    return new URL(props.report.url).hostname
  } catch {
    return props.report.url
  }
})

const ERA_LABELS: Record<string, string> = { modern: 'Streamable HTTP', 'legacy-streamable': 'Streamable HTTP (sessions)', 'legacy-sse': 'HTTP+SSE (deprecated)' }
const eraLabel = computed(() => (props.report.era ? ERA_LABELS[props.report.era] : undefined) ?? '—')

const gradeStyle = computed(() => ({
  A: 'bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/40',
  B: 'bg-lime-400/15 text-lime-300 ring-1 ring-lime-400/40',
  C: 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/40',
  D: 'bg-orange-400/15 text-orange-300 ring-1 ring-orange-400/40',
  F: 'bg-rose-400/15 text-rose-300 ring-1 ring-rose-400/40',
})[props.report.grade])

const statusIcon = { pass: '✓', warn: '!', fail: '✕', info: 'i', skip: '–' } as const
const statusStyle = {
  pass: 'bg-emerald-400/15 text-emerald-300',
  warn: 'bg-amber-400/15 text-amber-300',
  fail: 'bg-rose-400/15 text-rose-300',
  info: 'bg-white/10 text-silver',
  skip: 'bg-white/5 text-silver/70',
} as const

const CATEGORY_LABELS = { protocol: 'Protocol', tools: 'Tools', auth: 'Authentication', security: 'Security', performance: 'Speed' } as const
const ORDER = { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 } as const

const groups = computed(() =>
  (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[])
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      // Problems first, so the fixes are the first thing you read.
      checks: props.report.checks.filter((c) => c.category === category).sort((a, b) => ORDER[a.status] - ORDER[b.status]),
    }))
    .filter((g) => g.checks.length),
)

const tabs = computed(() => [
  { id: 'checks' as const, label: 'Checks', count: props.report.checks.filter((c) => c.status === 'fail' || c.status === 'warn').length || undefined },
  { id: 'tools' as const, label: 'Tools', count: props.report.tools.length },
  { id: 'more' as const, label: 'Prompts & resources', count: props.report.prompts.length + props.report.resources.length + props.report.resourceTemplates.length },
  { id: 'log' as const, label: 'Raw log', count: props.log.length },
  // Shared reports have no raw log (it's never stored).
].filter((t) => t.id !== 'log' || props.log.length))

const moreSections = computed(() => [
  { title: 'Prompts', items: props.report.prompts.map((p) => ({ key: p.name, description: p.description })) },
  { title: 'Resources', items: props.report.resources.map((r) => ({ key: r.uri, description: r.description ?? r.name })) },
  { title: 'Resource templates', items: props.report.resourceTemplates.map((r) => ({ key: r.uriTemplate, description: r.description ?? r.name })) },
])
</script>
