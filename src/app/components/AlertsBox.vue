<template>
  <details class="mt-4 text-xs text-silver">
    <summary class="cursor-pointer hover:text-white">Get alerts when this server's grade changes</summary>
    <div class="mt-3 space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 leading-relaxed">
      <p>
        <span class="text-white">Feed:</span> follow
        <a :href="feedUrl" class="font-mono text-white underline decoration-white/30 underline-offset-4 hover:decoration-white break-all">{{ feedUrl }}</a>
        in any feed reader. It updates when the server's grade changes or it stops responding.
      </p>

      <form v-if="!hook" class="space-y-2" @submit.prevent="add">
        <label for="webhook-url" class="block"><span class="text-white">Webhook:</span> MCP Check sends a POST to this URL for each change.
          Slack and Discord webhook URLs get a readable message; other URLs get signed JSON.</label>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input id="webhook-url" v-model="url" type="url" required inputmode="url" spellcheck="false" placeholder="https://hooks.slack.com/services/…"
                 class="min-w-0 flex-1 rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm text-white placeholder:text-silver/50 focus:border-white/40 focus:outline-none" />
          <button type="submit" :disabled="busy" class="rounded-lg border border-white/20 px-3 py-2 text-sm text-white transition hover:border-white/50 disabled:opacity-60 cursor-pointer">
            {{ busy ? 'Sending a test…' : 'Add webhook' }}
          </button>
        </div>
        <div ref="turnstileEl" class="empty:hidden"></div>
        <p v-if="error" role="alert" class="text-rose-300">{{ error }}</p>
      </form>

      <div v-else role="status" class="space-y-2">
        <p class="text-emerald-300">✓ Test message delivered. The webhook is active.</p>
        <template v-if="hook.format === 'json'">
          <p>Each request has an <code class="font-mono text-white/90">X-MCP-Check-Signature: sha256=…</code> header: the HMAC-SHA256 of the body with this secret. It's shown only once:</p>
          <pre class="overflow-x-auto rounded bg-black/40 p-3 font-mono text-white/90">{{ hook.secret }}</pre>
        </template>
        <p>To remove it later (keep this somewhere safe):</p>
        <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/40 p-3 font-mono text-white/90">{{ removeCommand }}</pre>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ApiError, subscribeWebhook } from '../api'
import { useTurnstile } from '../turnstile'

const props = defineProps<{ id: string }>()
const url = ref('')
const busy = ref(false)
const error = ref('')
const hook = ref<{ id: string; secret: string; format: string }>()
const { el: turnstileEl, getToken, reset } = useTurnstile('alerts')

const origin = typeof location === 'undefined' ? '' : location.origin
const feedUrl = computed(() => `${origin}/r/${props.id}/feed.xml`)
const removeCommand = computed(() =>
  hook.value ? `curl -X POST ${origin}/api/webhooks/${hook.value.id}/delete -H 'Content-Type: application/json' -d '{"secret":"${hook.value.secret}"}'` : '',
)

async function add() {
  busy.value = true
  error.value = ''
  try {
    hook.value = await subscribeWebhook(props.id, url.value.trim(), await getToken())
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'The webhook could not be added. Please try again.'
  } finally {
    reset()
    busy.value = false
  }
}
</script>
