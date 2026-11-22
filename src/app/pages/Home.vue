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
      <CheckForm ref="form" :busy="busy" :error="error" @submit="onSubmit" @signin="onSignIn" />
      <p v-if="!result && !busy" class="mt-6 text-xs text-silver">
        Also in your terminal: <code class="font-mono text-white/80">npx mcpcheck &lt;url&gt;</code>, and in CI as a
        <a href="https://github.com/DcodeNischal/mcp-check#github-action" target="_blank" rel="noopener" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">GitHub Action</a>.
      </p>
    </div>

    <div v-if="busy" class="mt-12 flex items-center gap-3 text-sm text-silver" role="status" aria-live="polite">
      <span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden="true"></span>
      Connecting, detecting the spec version, and running the checks…
    </div>

    <div v-if="result && !busy && needsSignIn" class="mt-12 flex flex-col gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.05] p-5 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm leading-relaxed text-silver">
        <span class="text-white">This server needs sign-in.</span>
        <template v-if="canSignIn"> Sign in to grade its tools and try them here. Your token stays in this tab.</template>
        <template v-else> Its sign-in only works with apps registered by hand, so paste a token under “Sign in, token or custom headers” to grade its tools.</template>
      </p>
      <button v-if="canSignIn" type="button" class="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200 cursor-pointer" @click="form?.signIn()">Sign in with OAuth</button>
    </div>

    <ReportView v-if="result && !busy" :report="result.report" :log="result.log" :target="target!">
      <template v-if="result.receipt" #actions>
        <ShareBox :key="result.report.checkedAt" :report="result.report" :receipt="result.receipt" />
      </template>
    </ReportView>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError, checkServer, claimSignIn, startSignIn, type Exchange, type Receipt, type Report, type Target } from '../api'
import CheckForm from '../components/CheckForm.vue'
import ReportView from '../components/ReportView.vue'
import ShareBox from '../components/ShareBox.vue'

const busy = ref(false)
const error = ref('')
const target = ref<Target>()
const result = ref<{ report: Report; log: Exchange[]; receipt?: Receipt }>()
const form = ref<InstanceType<typeof CheckForm>>()

const needsSignIn = computed(() => !!result.value?.report.auth?.required && !result.value.report.authenticated)
// MCP Check can sign in when the server has PKCE and lets new clients in without manual setup.
const canSignIn = computed(() => {
  const auth = result.value?.report.auth
  return !!auth?.authorizationEndpoint && !!auth.pkceS256 && !!(auth.clientIdMetadataDocuments || auth.dynamicRegistration)
})

async function onSignIn(url: string, token: string) {
  error.value = ''
  try {
    const { authorizeUrl } = await startSignIn(url, token)
    location.assign(authorizeUrl)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Sign-in could not be started. Please try again.'
  }
}

// Back from the server's sign-in page: pick up the token and run the check with it.
onMounted(async () => {
  const params = new URLSearchParams(location.search)
  if (params.get('signin') !== '1') return
  const url = params.get('url')
  history.replaceState(null, '', url ? `?url=${encodeURIComponent(url)}` : location.pathname)
  try {
    const signedIn = await claimSignIn()
    form.value?.useSignIn(signedIn.url, signedIn.accessToken)
    await form.value?.submit()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Sign-in could not be completed. Please try again.'
  }
})

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
