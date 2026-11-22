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
      <p class="font-mono text-[11px] uppercase tracking-[0.3em] text-silver">Shared report · checked {{ checkedAgo }}</p>
      <ReportView :report="report" :target="{ url: report.url, headers: {} }">
        <template #actions>
          <div class="flex flex-wrap items-center gap-3">
            <RouterLink :to="{ path: '/', query: { url: report.url } }" class="rounded-lg bg-white px-4 py-2 text-sm text-black">Check again</RouterLink>
            <p class="text-xs text-silver">Re-checking and sharing updates this report and its badge.</p>
          </div>
        </template>
      </ReportView>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getReport, type Report } from '../api'
import ReportView from '../components/ReportView.vue'

const route = useRoute()
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const report = ref<Report | null>(null)

const checkedAgo = computed(() => {
  if (!report.value) return ''
  const days = Math.floor((Date.now() - Date.parse(report.value.checkedAt)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
})

onMounted(async () => {
  try {
    report.value = await getReport(String(route.params.id))
    state.value = report.value ? 'ready' : 'missing'
  } catch {
    state.value = 'error'
  }
})
</script>
