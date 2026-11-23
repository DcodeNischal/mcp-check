<template>
  <!-- A white badge with a dark tick: the owner proved control of the server's domain. -->
  <!-- With no title it's decorative (the text beside it already says "Verified owner"). -->
  <span v-if="title" class="inline-flex shrink-0 align-middle" :title="title" role="img" :aria-label="title">
    <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#fff" d="M12 1.5l2.4 1.8 3-.2 1 2.8 2.6 1.6-.8 2.9 1.3 2.7-2.3 2 .1 3-2.9.8-1.5 2.6-2.9-.7-2.5 1.7-2.4-1.8-3 .2-1-2.8-2.6-1.6.8-2.9L1.7 12l2.3-2-.1-3 2.9-.8L8.3 3.6l2.9.7z" />
      <path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </span>
  <span v-else class="inline-flex shrink-0 align-middle" aria-hidden="true">
    <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#fff" d="M12 1.5l2.4 1.8 3-.2 1 2.8 2.6 1.6-.8 2.9 1.3 2.7-2.3 2 .1 3-2.9.8-1.5 2.6-2.9-.7-2.5 1.7-2.4-1.8-3 .2-1-2.8-2.6-1.6.8-2.9L1.7 12l2.3-2-.1-3 2.9-.8L8.3 3.6l2.9.7z" />
      <path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number; title?: string }>(), { size: 16, title: 'Verified owner' })
</script>
