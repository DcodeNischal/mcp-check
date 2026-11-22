<template>
  <!-- Temporary shell: the real interface is the next milestone. -->
  <main class="mx-auto max-w-2xl px-6 py-24">
    <h1 class="text-4xl font-light tracking-tight">MCP Check</h1>
    <p class="mt-4 text-neutral-400">Grade any remote MCP server. Under construction.</p>

    <form class="mt-10 flex gap-2" @submit.prevent="check">
      <input v-model="url" type="url" required placeholder="https://your-server.example/mcp"
             class="flex-1 rounded-lg border border-white/15 bg-transparent px-4 py-2" />
      <button class="rounded-lg bg-white px-4 py-2 text-black" :disabled="busy">{{ busy ? 'Checking…' : 'Check' }}</button>
    </form>

    <pre v-if="output" class="mt-8 overflow-auto rounded-lg border border-white/10 p-4 text-xs text-neutral-300">{{ output }}</pre>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const url = ref('')
const busy = ref(false)
const output = ref('')

async function check() {
  busy.value = true
  try {
    const res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value }) })
    output.value = JSON.stringify(await res.json(), null, 2)
  } finally {
    busy.value = false
  }
}
</script>
