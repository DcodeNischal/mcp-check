<template>
  <div>
    <section aria-labelledby="dir-title" class="max-w-3xl">
      <p class="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-300">Directory</p>
      <h1 id="dir-title" class="mt-4 text-4xl font-light tracking-tight md:text-5xl">Public MCP servers, graded.</h1>
      <p class="mt-4 text-base leading-relaxed text-silver">
        Every server here was checked by MCP Check and is re-checked every week. Public servers from the
        <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noopener" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">official MCP Registry</a>
        are added automatically.
        Want yours listed? <RouterLink to="/" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">Check it</RouterLink>, then share it to the directory.
        Follow new servers and grade changes with the <a href="/feed.xml" class="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">feed</a>.
      </p>
    </section>

    <form class="mt-10 flex flex-col gap-3 md:flex-row md:items-center" role="search" @submit.prevent>
      <label for="dir-search" class="sr-only">Search servers</label>
      <input id="dir-search" v-model="q" type="search" placeholder="Search by name, tool or what it does, like &quot;send email&quot;" spellcheck="false"
             class="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-sm placeholder:text-silver/60 focus:border-white/40 focus:outline-none" />
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by grade">
        <button v-for="g in ['', 'A', 'B', 'C', 'D', 'F']" :key="g || 'all'" type="button" :aria-pressed="grade === g"
                class="rounded-full border px-3 py-1.5 text-xs transition cursor-pointer"
                :class="grade === g ? 'border-white bg-white text-black' : 'border-white/15 text-silver hover:border-white/40 hover:text-white'"
                @click="setGrade(g)">{{ g || 'All' }}</button>
      </div>
      <label class="flex items-center gap-2 text-xs text-silver">
        Sort
        <select v-model="sort" class="rounded-lg border border-white/15 bg-black px-2 py-1.5 text-xs text-white">
          <option value="">{{ searching ? 'Best match' : 'Best grade' }}</option>
          <option v-if="searching" value="grade">Best grade</option>
          <option value="recent">Recently checked</option>
        </select>
      </label>
    </form>

    <p class="mt-6 text-xs text-silver" aria-live="polite">
      <template v-if="state === 'ready'">{{ total }} server{{ total === 1 ? '' : 's' }}<template v-if="q || grade"> found</template></template>
      <template v-else-if="state === 'loading'">Loading…</template>
    </p>

    <p v-if="state === 'error'" role="alert" class="mt-4 text-sm text-rose-300">The directory couldn't be loaded. Please try again.</p>

    <div v-else-if="state === 'ready' && !servers.length" class="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
      <p class="text-white">{{ q || grade ? 'No servers match.' : 'No servers listed yet.' }}</p>
      <RouterLink to="/" class="mt-4 inline-block rounded-lg bg-white px-4 py-2 text-sm text-black">Check a server</RouterLink>
    </div>

    <ul v-else class="mt-4 divide-y divide-white/5 rounded-2xl border border-white/10">
      <li v-for="s in servers" :key="s.id">
        <RouterLink :to="`/r/${s.id}`" class="flex items-center gap-4 px-5 py-4 transition hover:bg-white/[0.03]">
          <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xl font-medium" :class="gradeStyle(s.grade)" :aria-label="`Grade ${s.grade}`">{{ s.grade }}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-white">{{ s.name || hostOf(s.url) }}</span>
            <span class="block truncate font-mono text-xs text-silver">{{ s.url }}</span>
            <span v-if="s.description" class="mt-1 block truncate text-xs text-silver/80">{{ s.description }}</span>
            <span v-if="s.match" class="mt-1 block truncate font-mono text-[11px] text-emerald-300/90">{{ s.match }}</span>
          </span>
          <span class="hidden shrink-0 text-right text-xs text-silver sm:block">
            <span class="block">{{ s.auth_required ? 'Sign-in required' : `${s.tools_count} tool${s.tools_count === 1 ? '' : 's'}` }}</span>
            <span class="block text-silver/70">{{ s.spec_version ?? '—' }} · {{ s.score }}/100{{ s.partial ? '*' : '' }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>

    <nav v-if="pages > 1" class="mt-6 flex items-center justify-between text-sm" aria-label="Pages">
      <button type="button" :disabled="page <= 1" class="rounded-lg border border-white/15 px-3 py-1.5 disabled:opacity-40 cursor-pointer" @click="page--">← Previous</button>
      <span class="text-silver">Page {{ page }} of {{ pages }}</span>
      <button type="button" :disabled="page >= pages" class="rounded-lg border border-white/15 px-3 py-1.5 disabled:opacity-40 cursor-pointer" @click="page++">Next →</button>
    </nav>
    <p v-if="servers.some((s) => s.partial)" class="mt-4 text-xs text-silver/70">* Partial grade: the server requires sign-in, so its tools weren't graded.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listServers, type DirectoryEntry } from '../api'

const route = useRoute()
const router = useRouter()
const q = ref(String(route.query.q ?? ''))
const grade = ref(/^[ABCDF]$/.test(String(route.query.grade ?? '')) ? String(route.query.grade) : '')
// '' means the default order: best match while searching, best grade otherwise.
const sort = ref(route.query.sort === 'recent' || route.query.sort === 'grade' ? String(route.query.sort) : '')
const searching = computed(() => q.value.trim() !== '')
const page = ref(Math.max(1, Number(route.query.page) || 1))
const servers = ref<DirectoryEntry[]>([])
const total = ref(0)
const pageSize = ref(30)
const state = ref<'loading' | 'ready' | 'error'>('loading')
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

let latest = 0
async function load() {
  const ticket = ++latest
  state.value = 'loading'
  // Keep the filters in the address bar so a filtered view can be shared or bookmarked.
  router.replace({ query: { ...(q.value ? { q: q.value } : {}), ...(grade.value ? { grade: grade.value } : {}), ...(sort.value ? { sort: sort.value } : {}), ...(page.value > 1 ? { page: String(page.value) } : {}) } })
  try {
    const res = await listServers({ q: q.value.trim(), grade: grade.value, sort: sort.value, page: page.value })
    if (ticket !== latest) return
    servers.value = res.servers
    total.value = res.total
    pageSize.value = res.pageSize
    state.value = 'ready'
  } catch {
    if (ticket === latest) state.value = 'error'
  }
}

function setGrade(g: string) {
  grade.value = g
  page.value = 1
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => {
  clearTimeout(timer)
  // "Best grade" is only a separate choice while searching.
  if (!searching.value && sort.value === 'grade') sort.value = ''
  timer = setTimeout(() => {
    page.value = 1
    void load()
  }, 250)
})
watch([grade, sort, page], () => void load())
onMounted(load)

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return u
  }
}
const gradeStyle = (g: string) =>
  ({
    A: 'bg-emerald-400/15 text-emerald-300',
    B: 'bg-lime-400/15 text-lime-300',
    C: 'bg-amber-400/15 text-amber-300',
    D: 'bg-orange-400/15 text-orange-300',
    F: 'bg-rose-400/15 text-rose-300',
  })[g] ?? 'bg-white/10 text-white'
</script>
