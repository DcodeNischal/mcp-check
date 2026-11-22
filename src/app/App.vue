<template>
  <div class="min-h-screen flex flex-col">
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-black">Skip to content</a>

    <header class="border-b border-white/10">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
        <RouterLink to="/" class="flex items-center gap-2 font-mono text-sm tracking-tight">
          <span class="grid h-6 w-6 place-items-center rounded-md bg-white text-[11px] font-bold text-black" aria-hidden="true">✓</span>
          MCP Check
        </RouterLink>
        <nav aria-label="Main" class="flex items-center gap-5 text-sm text-silver">
          <RouterLink to="/" class="hover:text-white" active-class="" exact-active-class="text-white">Check</RouterLink>
          <RouterLink to="/servers" class="hover:text-white" active-class="text-white">Directory</RouterLink>
          <a href="https://github.com/DcodeNischal/mcp-check" target="_blank" rel="noopener" class="hover:text-white">GitHub</a>
        </nav>
      </div>
    </header>

    <main id="main" class="mx-auto w-full max-w-5xl flex-1 px-5 pb-24 pt-14 md:pt-20" tabindex="-1">
      <RouterView />
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
const nexus402 = 'https://app.nexus402.dev/?utm_source=mcp-check&utm_medium=referral&utm_campaign=nexus402_launch&utm_content=footer'
</script>
