<script setup>
import { computed, ref } from 'vue'
import { withBase } from 'vitepress'

// The demo is the viewer node-schema-viewer serves (the pinned laranex-schema-viewer-ui files) loading synthetic
// shared contract fixtures. Nothing here talks to a backend. The viewer follows the system theme and has its own
// theme toggle.
const snapshots = [
  { page: 'index.html', label: 'Three connections · combined' },
  { page: 'compare.html', label: 'Primary and replica compared' },
]
const page = ref(snapshots[0].page)
const ready = ref(false)
const src = computed(() => withBase(`/demo/${page.value}`))
</script>

<template>
  <section class="lx-demo" aria-label="Synthetic schema demonstration">
    <div class="lx-demo-bar">
      <span><i></i><i></i><i></i><b>INTERACTIVE DEMO</b></span>
      <label class="lx-demo-pick">Schema
        <select v-model="page" @change="ready = false">
          <option v-for="s in snapshots" :key="s.page" :value="s.page">{{ s.label }}</option>
        </select>
      </label>
    </div>
    <iframe :src="src" title="Interactive ERD of a synthetic schema" loading="lazy" @load="ready = true"></iframe>
    <div class="lx-demo-footer"><span>{{ ready ? 'Drag to explore · scroll to zoom · select for details · press S for shortcuts' : 'Loading the demo when it comes into view…' }}</span><a :href="src" target="_blank" rel="noopener">Open full screen ↗</a></div>
  </section>
</template>
