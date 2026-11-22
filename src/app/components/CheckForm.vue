<template>
  <form class="w-full" @submit.prevent="submit">
    <label for="server-url" class="sr-only">MCP server URL</label>
    <div class="flex flex-col sm:flex-row gap-2">
      <input id="server-url" v-model="url" type="url" required inputmode="url" autocomplete="url" spellcheck="false"
             placeholder="https://your-server.example.com/mcp"
             class="flex-1 min-w-0 rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3.5 font-mono text-sm text-white placeholder:text-silver/60 focus:border-white/40 focus:outline-none" />
      <button type="submit" :disabled="busy"
              class="rounded-xl bg-white px-6 py-3.5 text-sm font-medium text-black transition hover:bg-neutral-200 disabled:opacity-60 cursor-pointer">
        {{ busy ? 'Checking…' : 'Check server' }}
      </button>
    </div>

    <details class="mt-3 group" :open="showAuth" @toggle="showAuth = ($event.target as HTMLDetailsElement).open">
      <summary class="cursor-pointer list-none text-xs text-silver hover:text-white">
        <span class="inline-block transition group-open:rotate-90">›</span> Token or custom headers (for protected servers)
      </summary>
      <div class="mt-3 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <label class="block">
          <span class="text-[11px] font-mono uppercase tracking-widest text-silver">Bearer token</span>
          <input v-model="token" type="password" autocomplete="off" spellcheck="false" placeholder="Optional"
                 class="mt-1.5 w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm focus:border-white/40 focus:outline-none" />
        </label>
        <div v-for="(h, i) in extra" :key="i" class="flex gap-2">
          <input v-model="h.name" aria-label="Header name" placeholder="Header name" spellcheck="false"
                 class="w-2/5 rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm focus:border-white/40 focus:outline-none" />
          <input v-model="h.value" aria-label="Header value" type="password" placeholder="Value" autocomplete="off"
                 class="flex-1 min-w-0 rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm focus:border-white/40 focus:outline-none" />
          <button type="button" class="px-2 text-silver hover:text-white cursor-pointer" :aria-label="`Remove header ${h.name || i + 1}`" @click="extra.splice(i, 1)">✕</button>
        </div>
        <button v-if="extra.length < 5" type="button" class="text-xs text-silver hover:text-white cursor-pointer" @click="extra.push({ name: '', value: '' })">+ Add header</button>
        <p class="text-xs leading-relaxed text-silver/80">Sent only to the server you're checking, for this check. Never stored or shown in reports.</p>
      </div>
    </details>

    <div ref="turnstileEl" class="mt-3 empty:hidden"></div>
    <p v-if="error" role="alert" class="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/[0.06] px-4 py-3 text-sm text-rose-300">{{ error }}</p>
  </form>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Target } from '../api'
import { useTurnstile } from '../turnstile'

defineProps<{ busy: boolean; error?: string }>()
const emit = defineEmits<{ submit: [target: Target, token: string] }>()

const url = ref('')
const token = ref('')
const extra = ref<{ name: string; value: string }[]>([])
const showAuth = ref(false)
const { el: turnstileEl, getToken, reset } = useTurnstile('check')

onMounted(() => {
  // A link like ?url=https://… pre-fills the form (it never runs a check by itself).
  const fromLink = new URLSearchParams(location.search).get('url')
  if (fromLink) url.value = fromLink
})

async function submit() {
  const headers: Record<string, string> = {}
  if (token.value.trim()) headers.Authorization = `Bearer ${token.value.trim()}`
  for (const h of extra.value) if (h.name.trim() && h.value) headers[h.name.trim()] = h.value
  const human = await getToken()
  emit('submit', { url: url.value.trim(), headers }, human)
  reset()
}

defineExpose({ setUrl: (u: string) => (url.value = u) })
</script>
