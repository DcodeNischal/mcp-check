<template>
  <div>
    <p v-if="state === 'loading'" class="text-sm text-silver" role="status">Loading report…</p>

    <div v-else-if="state === 'missing'" class="max-w-xl">
      <h1 class="text-3xl font-light tracking-tight">Report not found.</h1>
      <p class="mt-3 text-silver">This private link doesn't match a report. Private reports expire after {{ PRIVATE_TTL_DAYS }} days.</p>
      <RouterLink to="/" class="mt-6 inline-block rounded-lg bg-white px-4 py-2 text-sm text-black">Check a server</RouterLink>
    </div>

    <p v-else-if="state === 'error'" role="alert" class="text-sm text-rose-300">This report could not be loaded. Please try again.</p>

    <template v-else-if="report">
      <p class="font-mono text-[11px] uppercase tracking-[0.3em] text-silver">Private report · expires {{ expires }}</p>
      <p class="mt-3 max-w-3xl text-sm leading-relaxed text-amber-300">
        This check was made with a token or custom headers, so it may show tools the public can't see. Anyone with this link can
        open it until it expires. It isn't listed anywhere or shown to search engines.
      </p>
      <ReportView :report="report" :target="{ url: report.url, headers: {} }" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getPrivateReport, type Report } from '../api'
import ReportView from '../components/ReportView.vue'

const PRIVATE_TTL_DAYS = 30
const route = useRoute()
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const report = ref<Report | null>(null)
const expiresAt = ref('')
const expires = computed(() => (expiresAt.value ? new Date(expiresAt.value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''))

onMounted(async () => {
  try {
    const found = await getPrivateReport(String(route.params.id))
    report.value = found?.report ?? null
    expiresAt.value = found?.expiresAt ?? ''
    state.value = report.value ? 'ready' : 'missing'
  } catch {
    state.value = 'error'
  }
})
</script>
