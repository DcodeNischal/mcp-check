<template>
  <div>
    <p v-if="state === 'loading'" class="text-sm text-silver" role="status">Loading report…</p>

    <div v-else-if="state === 'missing'" class="max-w-xl">
      <h1 class="text-3xl font-light tracking-tight">Report not found.</h1>
      <p class="mt-3 text-silver">This link doesn't match a shared report. It may have been removed.</p>
      <RouterLink to="/" class="mt-6 inline-block rounded-lg bg-white px-4 py-2 text-sm text-black">Check a server</RouterLink>
    </div>

    <p v-else-if="state === 'error'" role="alert" class="text-sm text-rose-300">This report could not be loaded. Please try again.</p>

    <template v-else-if="report">
      <p class="font-mono text-[11px] uppercase tracking-[0.3em] text-silver">{{ registry ? 'Directory' : 'Shared report' }} · checked {{ checkedAgo }}</p>
      <div v-if="registry" class="mt-4 max-w-3xl">
        <p v-if="registry.description" class="text-base leading-relaxed text-silver">{{ registry.description }}</p>
        <p class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-silver">
          <a v-if="registry.repositoryUrl" :href="registry.repositoryUrl" target="_blank" rel="nofollow ugc noopener noreferrer" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Source code</a>
          <a v-if="registry.websiteUrl" :href="registry.websiteUrl" target="_blank" rel="nofollow ugc noopener noreferrer" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Website</a>
          <span>In the <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener" class="underline decoration-white/30 underline-offset-4 hover:text-white">MCP Registry</a> as <code class="font-mono text-white/80">{{ registry.name }}</code></span>
        </p>
      </div>
      <ReportView :report="report" :target="{ url: report.url, headers: {} }">
        <template #actions>
          <div class="flex flex-wrap items-center gap-3">
            <RouterLink :to="{ path: '/', query: { url: report.url } }" class="rounded-lg bg-white px-4 py-2 text-sm text-black">Check again</RouterLink>
            <p class="text-xs text-silver">Re-checking and sharing updates this report and its badge.</p>
            <RouterLink v-if="listed" to="/servers" class="ml-auto rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">In the public directory</RouterLink>
          </div>
          <details v-if="listed" class="mt-4 text-xs text-silver">
            <summary class="cursor-pointer hover:text-white">Own this server? Remove it from the directory</summary>
            <div class="mt-3 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 leading-relaxed">
              <p>Prove you control the domain by serving this text at <code class="font-mono text-white/90 break-all">{{ proofUrl }}</code>:</p>
              <pre class="rounded bg-black/40 p-3 font-mono text-white/90">mcp-check: remove {{ id }}</pre>
              <button type="button" :disabled="removing" class="rounded-lg border border-white/15 px-3 py-1.5 text-white hover:bg-white/5 disabled:opacity-50 cursor-pointer" @click="remove">
                {{ removing ? 'Checking…' : 'Verify and remove' }}
              </button>
              <p v-if="removeMessage" role="status" :class="removed ? 'text-emerald-300' : 'text-rose-300'">{{ removeMessage }}</p>
            </div>
          </details>
        </template>
      </ReportView>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError, getReport, unlistServer, type RegistryInfo, type Report } from '../api'
import ReportView from '../components/ReportView.vue'

const route = useRoute()
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const report = ref<Report | null>(null)
const listed = ref(false)
const registry = ref<RegistryInfo>()
const id = String(route.params.id)
const removing = ref(false)
const removed = ref(false)
const removeMessage = ref('')

const proofUrl = computed(() => {
  try {
    return `${new URL(report.value?.url ?? '').origin}/.well-known/mcp-check.txt`
  } catch {
    return ''
  }
})

async function remove() {
  removing.value = true
  removeMessage.value = ''
  try {
    const res = await unlistServer(id)
    removed.value = true
    listed.value = false
    removeMessage.value = res.message
  } catch (err) {
    removeMessage.value = err instanceof ApiError ? err.message : 'Verification failed. Please try again.'
  } finally {
    removing.value = false
  }
}

const checkedAgo = computed(() => {
  if (!report.value) return ''
  const days = Math.floor((Date.now() - Date.parse(report.value.checkedAt)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
})

onMounted(async () => {
  try {
    const found = await getReport(id)
    report.value = found?.report ?? null
    listed.value = !!found?.listed
    registry.value = found?.registry
    state.value = report.value ? 'ready' : 'missing'
  } catch {
    state.value = 'error'
  }
})
</script>
