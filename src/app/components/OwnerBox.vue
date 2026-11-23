<template>
  <details class="mt-4 text-xs text-silver" :open="justVerified || blocked">
    <summary class="cursor-pointer hover:text-white">{{ blocked ? 'Own this server? List it again' : 'Own this server? Verify it, or remove it from the directory' }}</summary>
    <div class="mt-3 space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4 leading-relaxed">
      <p>
        Prove you control the domain by serving a line of text at
        <code class="font-mono text-white/90 break-all">{{ proofUrl }}</code>, then press the button below it.
      </p>

      <p v-if="blocked" class="text-amber-300">Its owner removed this server from the directory. Verifying ownership lists it again.</p>
      <div class="grid gap-4" :class="blocked ? '' : 'sm:grid-cols-2'">
        <div class="space-y-2">
          <p class="text-white">Verify ownership</p>
          <p>Your server's page shows a verified-owner mark for as long as the line stays up (it's checked at every weekly re-check).<template v-if="!blocked"> If you removed the server, verifying lists it again.</template></p>
          <pre class="overflow-x-auto rounded bg-black/40 p-3 font-mono text-white/90">mcp-check: verify {{ id }}</pre>
          <button type="button" :disabled="busy !== ''" class="rounded-lg border border-white/15 px-3 py-1.5 text-white hover:bg-white/5 disabled:opacity-50 cursor-pointer" @click="run('verify')">
            {{ busy === 'verify' ? 'Checking…' : 'Verify' }}
          </button>
        </div>
        <div v-if="!blocked" class="space-y-2">
          <p class="text-white">Remove from the directory</p>
          <p>The server is taken out of the directory until you verify ownership again.</p>
          <pre class="overflow-x-auto rounded bg-black/40 p-3 font-mono text-white/90">mcp-check: remove {{ id }}</pre>
          <button type="button" :disabled="busy !== ''" class="rounded-lg border border-white/15 px-3 py-1.5 text-white hover:bg-white/5 disabled:opacity-50 cursor-pointer" @click="run('remove')">
            {{ busy === 'remove' ? 'Checking…' : 'Verify and remove' }}
          </button>
        </div>
      </div>
      <p v-if="message" role="status" :class="ok ? 'text-emerald-300' : 'text-rose-300'">{{ message }}</p>
      <p>
        Unwanted alerts on your server? With the verify line in place,
        <button type="button" :disabled="busy !== ''" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white disabled:opacity-50 cursor-pointer" @click="run('clear')">{{ busy === 'clear' ? 'checking…' : 'remove every webhook on it' }}</button>.
      </p>

      <!-- For the owner who just verified: the one moment charging for their tools is relevant. -->
      <div v-if="justVerified" class="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-4">
        <p class="text-sm text-white">Thinking of charging for these tools?</p>
        <p class="mt-1">
          Nexus402 lets you set a price for each tool, and agents pay per call from a prepaid wallet, with no billing code on your side.
          It opens soon: join the launch list and you'll get one email when it does.
        </p>
        <a :href="nexus402('verified_owner')" target="_blank" rel="noopener" class="mt-3 inline-block rounded-lg bg-white px-3 py-1.5 text-sm text-black">Join the Nexus402 launch list</a>
      </div>
      <p v-else>
        Want to charge for your tools? Here's
        <a href="https://nischaldhakal.com.np/blog/how-to-charge-for-an-mcp-tool" target="_blank" rel="noopener" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">how to charge for an MCP tool</a>,
        including <a :href="nexus402('owner_section')" target="_blank" rel="noopener" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Nexus402</a>,
        a clearinghouse for paid MCP tools opening soon.
      </p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ApiError, clearAlerts, unlistServer, verifyOwner } from '../api'

const props = defineProps<{ id: string; url: string; blocked?: boolean }>()
const emit = defineEmits<{ verified: [at: string, relisted: boolean]; removed: [] }>()
const busy = ref<'' | 'verify' | 'remove' | 'clear'>('')
const message = ref('')
const ok = ref(false)
const justVerified = ref(false)

const proofUrl = computed(() => {
  try {
    return `${new URL(props.url).origin}/.well-known/mcp-check.txt`
  } catch {
    return ''
  }
})

// Tagged so Nexus402's analytics can tell which spot on MCP Check drove a sign-up.
const nexus402 = (placement: string) =>
  `https://app.nexus402.dev/?utm_source=mcp-check&utm_medium=referral&utm_campaign=nexus402_launch&utm_content=${placement}`

async function run(action: 'verify' | 'remove' | 'clear') {
  busy.value = action
  message.value = ''
  try {
    if (action === 'verify') {
      const res = await verifyOwner(props.id)
      justVerified.value = true
      emit('verified', res.verifiedAt, res.relisted)
      message.value = res.message
    } else if (action === 'clear') {
      message.value = (await clearAlerts(props.id)).message
    } else {
      const res = await unlistServer(props.id)
      emit('removed')
      message.value = res.message
    }
    ok.value = true
  } catch (err) {
    ok.value = false
    message.value = err instanceof ApiError ? err.message : 'Verification failed. Please try again.'
  } finally {
    busy.value = ''
  }
}
</script>
