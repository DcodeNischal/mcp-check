<template>
  <div class="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
    <div v-if="!shared" class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="text-sm text-white">Share this report</p>
        <p class="mt-1 text-xs leading-relaxed text-silver">
          Get a public link and a README badge. Sharing again later updates the same link and badge.
          <template v-if="report.authenticated"><br /><span class="text-amber-300">This check used your credentials, so sharing makes its tool list public.</span></template>
        </p>
      </div>
      <div class="flex shrink-0 flex-col items-start gap-2 sm:items-end">
        <button type="button" :disabled="busy" class="rounded-lg bg-white px-4 py-2 text-sm text-black disabled:opacity-60 cursor-pointer" @click="share">
          {{ busy ? 'Sharing…' : 'Share report' }}
        </button>
        <label v-if="!report.authenticated" class="flex items-center gap-2 text-xs text-silver">
          <input v-model="list" type="checkbox" /> List in the public directory
        </label>
      </div>
    </div>

    <div v-else class="space-y-4">
      <p class="text-sm text-emerald-300">
        Shared. Anyone with the link can see this report.
        <template v-if="shared.listed"> It's <RouterLink to="/servers" class="underline underline-offset-4">listed in the directory</RouterLink>.</template>
        <span v-else-if="shared.blocked" class="text-silver">Its owner removed it from the directory, so it isn't listed.</span>
        <span v-if="shared.kept" class="block text-silver">A newer report, or the public listing, is already stored for this server, so the link shows that one. Reports made with a token or custom headers never replace a public listing.</span>
      </p>
      <div v-for="item in links" :key="item.label">
        <p class="text-[11px] font-mono uppercase tracking-widest text-silver">{{ item.label }}</p>
        <div class="mt-1.5 flex gap-2">
          <input :value="item.value" readonly :aria-label="item.label" class="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-xs text-white/90" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" class="shrink-0 rounded-lg border border-white/15 px-3 py-2 text-xs hover:bg-white/5 cursor-pointer" @click="copy(item)">{{ copied === item.label ? 'Copied' : 'Copy' }}</button>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <img :src="shared.badgeUrl" alt="MCP Check badge preview" height="20" />
        <a :href="shared.reportUrl" class="text-xs text-silver underline decoration-white/30 underline-offset-4 hover:text-white">Open the report page</a>
      </div>
    </div>
    <p v-if="error" role="alert" class="mt-3 text-sm text-rose-300">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ApiError, shareReport, type Receipt, type Report } from '../api'

const props = defineProps<{ report: Report; receipt: Receipt }>()
const busy = ref(false)
const error = ref('')
const copied = ref('')
const shared = ref<{ reportUrl: string; badgeUrl: string; listed: boolean; blocked: boolean; kept: boolean } | null>(null)
const list = ref(true)

const links = computed(() =>
  shared.value
    ? [
        { label: 'Report link', value: shared.value.reportUrl },
        { label: 'README badge (Markdown)', value: `[![MCP Check](${shared.value.badgeUrl})](${shared.value.reportUrl})` },
      ]
    : [],
)

async function share() {
  busy.value = true
  error.value = ''
  try {
    const res = await shareReport(props.receipt, list.value && !props.report.authenticated)
    shared.value = { reportUrl: res.reportUrl, badgeUrl: res.badgeUrl, listed: res.listed, blocked: res.blocked, kept: res.saved === false }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Sharing failed. Please try again.'
  } finally {
    busy.value = false
  }
}

async function copy(item: { label: string; value: string }) {
  try {
    await navigator.clipboard.writeText(item.value)
    copied.value = item.label
    setTimeout(() => (copied.value = ''), 2000)
  } catch {
    // Clipboard blocked: the field is selectable as a fallback.
  }
}
</script>
