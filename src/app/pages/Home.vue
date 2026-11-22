<template>
  <div>
    <section aria-labelledby="hero-title" class="max-w-3xl">
      <p class="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-300">Free · No sign-up</p>
      <h1 id="hero-title" class="mt-4 text-4xl font-light tracking-tight md:text-6xl">Grade any MCP server.</h1>
      <p class="mt-5 max-w-2xl text-base leading-relaxed text-silver md:text-lg">
        Paste a server URL. MCP Check tests it against the current spec, grades its tools, auth, security and speed,
        and tells you exactly how to fix what it finds. Then try its tools right here.
      </p>
    </section>

    <div class="mt-10 max-w-3xl">
      <CheckForm :busy="busy" :error="error" @submit="onSubmit" />
    </div>

    <div v-if="busy" class="mt-12 flex items-center gap-3 text-sm text-silver" role="status" aria-live="polite">
      <span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden="true"></span>
      Connecting, detecting the spec version, and running the checks…
    </div>

    <ReportView v-if="result && !busy" :report="result.report" :log="result.log" :target="target!">
      <template v-if="result.receipt" #actions>
        <ShareBox :key="result.report.checkedAt" :report="result.report" :receipt="result.receipt" />
      </template>
    </ReportView>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ApiError, checkServer, type Exchange, type Receipt, type Report, type Target } from '../api'
import CheckForm from '../components/CheckForm.vue'
import ReportView from '../components/ReportView.vue'
import ShareBox from '../components/ShareBox.vue'

const busy = ref(false)
const error = ref('')
const target = ref<Target>()
const result = ref<{ report: Report; log: Exchange[]; receipt?: Receipt }>()

async function onSubmit(t: Target, token: string) {
  busy.value = true
  error.value = ''
  try {
    const res = await checkServer(t, token)
    target.value = t
    result.value = { report: res.report, log: res.log, ...(res.receipt ? { receipt: res.receipt } : {}) }
    // Keep the URL in the address bar so the page can be refreshed or bookmarked (never the token).
    history.replaceState(null, '', `?url=${encodeURIComponent(t.url)}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    busy.value = false
  }
}
</script>
