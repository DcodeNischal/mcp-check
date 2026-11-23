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
      <p class="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.3em] text-silver">
        <span>{{ registry ? 'Directory' : 'Shared report' }} · checked {{ checkedAgo }}</span>
        <span v-if="verifiedAt" class="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 normal-case tracking-normal text-white" :title="`The owner proved control of the domain on ${verifiedAt.slice(0, 10)}`"><VerifiedTick :size="14" title="" />Verified owner</span>
      </p>
      <div v-if="registry" class="mt-4 max-w-3xl">
        <p v-if="registry.description" class="text-base leading-relaxed text-silver">{{ registry.description }}</p>
        <p class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-silver">
          <a v-if="registry.repositoryUrl" :href="registry.repositoryUrl" target="_blank" rel="nofollow ugc noopener noreferrer" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Source code</a>
          <a v-if="registry.websiteUrl" :href="registry.websiteUrl" target="_blank" rel="nofollow ugc noopener noreferrer" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Website</a>
          <span>In the <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener" class="underline decoration-white/30 underline-offset-4 hover:text-white">MCP Registry</a> as <code class="font-mono text-white/80">{{ registry.name }}</code></span>
        </p>
      </div>
      <ReportView :report="report" :target="{ url: report.url, headers: {} }" :verified="!!verifiedAt">
        <template #actions>
          <div class="flex flex-wrap items-center gap-3">
            <RouterLink :to="{ path: '/', query: { url: report.url } }" class="rounded-lg bg-white px-4 py-2 text-sm text-black">Check again</RouterLink>
            <p class="text-xs text-silver">Re-checking and sharing updates this report and its badge.</p>
            <RouterLink v-if="listed" to="/servers" class="ml-auto rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">In the public directory</RouterLink>
          </div>
          <AlertsBox v-if="listed" :id="id" />
          <OwnerBox v-if="listed" :id="id" :url="report.url" @verified="(at) => (verifiedAt = at)" @removed="listed = false" />
        </template>
      </ReportView>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getReport, type RegistryInfo, type Report } from '../api'
import AlertsBox from '../components/AlertsBox.vue'
import OwnerBox from '../components/OwnerBox.vue'
import VerifiedTick from '../components/VerifiedTick.vue'
import ReportView from '../components/ReportView.vue'

const route = useRoute()
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const report = ref<Report | null>(null)
const listed = ref(false)
const registry = ref<RegistryInfo>()
const id = String(route.params.id)
const verifiedAt = ref<string>()

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
    verifiedAt.value = found?.verifiedAt
    state.value = report.value ? 'ready' : 'missing'
  } catch {
    state.value = 'error'
  }
})
</script>
