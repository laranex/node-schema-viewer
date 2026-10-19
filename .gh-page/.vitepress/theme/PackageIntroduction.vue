<script setup>
import { ref } from 'vue'
import { withBase } from 'vitepress'

const command = 'npm install --save-dev node-schema-viewer'
const message = ref('Copy command')
async function copy() {
  try {
    await navigator.clipboard.writeText(command)
    message.value = 'Copied'
  } catch {
    message.value = 'Select and copy the command below'
  }
}
</script>

<template>
  <header class="lx-package">
    <p class="lx-eyebrow">NODE.JS TOOLING, WITH A CLEARER PICTURE</p>
    <h1>Laranex<i>.</i><br /><span>Schema Viewer for Node.js</span></h1>
    <p class="lx-lead">Understand how your data fits together.<br />Tables, constraints, and relationships — in one explorable view.</p>
    <div class="lx-tags"><span>Node.js 22.13+</span><span>PostgreSQL</span><span>MySQL</span><span>MariaDB</span><span>SQLite</span><span class="accent">Read-only MCP</span><span>Drift gate</span><span>MIT</span></div>
    <div class="lx-terminal">
      <div class="lx-terminal-bar"><i></i><i></i><i></i><span>install</span><button @click="copy" :aria-label="message">{{ message === 'Copied' ? 'Copied ✓' : 'Copy' }}</button></div>
      <div class="lx-install"><span aria-hidden="true">$</span><code>{{ command }}</code></div>
    </div>
    <p class="lx-caption">Requires Node.js 22.13 or later (22, 24 and 26 are tested). Version 0.1.1 is the first release; build supports Drizzle and live databases so far.</p>
    <span class="sr-only" role="status">{{ message }}</span>
    <div class="lx-actions"><a class="lx-button primary" :href="withBase('/quick-start.html')">Get started <span aria-hidden="true">→</span></a><a class="lx-button secondary" :href="withBase('/demo.html')">Explore the live demo</a></div>
  </header>
</template>
