<template>
  <div class="min-h-screen flex flex-col">
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-black">Skip to content</a>

    <header class="border-b border-white/10">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
        <a href="/" class="flex items-center gap-2 font-mono text-sm tracking-tight">
          <span class="grid h-6 w-6 place-items-center rounded-md bg-white text-[11px] font-bold text-black" aria-hidden="true">✓</span>
          MCP Check
        </a>
        <nav aria-label="Main" class="flex items-center gap-5 text-sm text-silver">
          <a href="https://github.com/DcodeNischal/mcp-check" target="_blank" rel="noopener" class="hover:text-white">GitHub</a>
        </nav>
      </div>
    </header>

    <main id="main" class="mx-auto w-full max-w-5xl flex-1 px-5 pb-24 pt-14 md:pt-20" tabindex="-1">
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

      <ReportView v-if="result && !busy" :report="result.report" :log="result.log" :target="target!" />
    </main>

    <footer class="border-t border-white/10">
      <div class="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-8 text-sm text-silver md:flex-row md:items-center md:justify-between">
        <p>
          Built by <a href="https://nischaldhakal.com.np" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Nischal Dhakal</a>.
          Open source on <a href="https://github.com/DcodeNischal/mcp-check" target="_blank" rel="noopener" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">GitHub</a>.
        </p>
        <p>
          Want to charge for your MCP tools?
          <a :href="nexus402" target="_blank" rel="noopener" class="text-emerald-300 underline decoration-emerald-300/40 underline-offset-4 hover:decoration-emerald-300">Nexus402 →</a>
        </p>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ApiError, checkServer, type Exchange, type Report, type Target } from './api'
import CheckForm from './components/CheckForm.vue'
import ReportView from './components/ReportView.vue'

const nexus402 = 'https://app.nexus402.dev/?utm_source=mcp-check&utm_medium=referral&utm_campaign=nexus402_launch&utm_content=footer'

const busy = ref(false)
const error = ref('')
const target = ref<Target>()
const result = ref<{ report: Report; log: Exchange[] }>()

async function onSubmit(t: Target, token: string) {
  busy.value = true
  error.value = ''
  try {
    const res = await checkServer(t, token)
    target.value = t
    result.value = { report: res.report, log: res.log }
    // Keep the URL in the address bar so the page can be refreshed or bookmarked (never the token).
    history.replaceState(null, '', `?url=${encodeURIComponent(t.url)}`)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
  } finally {
    busy.value = false
  }
}
</script>
