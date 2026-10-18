import { defineConfig } from 'vitepress'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const base = '/node-schema-viewer/'
const repository = 'https://github.com/laranex/node-schema-viewer'
const require = createRequire(import.meta.url)

export default defineConfig({
  title: 'Laranex Schema Viewer for Node.js',
  description: 'Serve the shared Laranex Schema Viewer and read-only MCP tools from saved laranex-schema documents, compare schemas, and gate schema drift in CI, from Node.js.',
  lang: 'en-US',
  base,
  cleanUrls: false,
  appearance: 'dark',
  srcDir: '../docs',
  vite: {
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    // Markdown lives outside the Node project; resolve Vue from this project.
    resolve: { alias: [
      { find: /^vue$/, replacement: require.resolve('vue/dist/vue.runtime.esm-bundler.js') },
      { find: 'vue/server-renderer', replacement: require.resolve('vue/server-renderer') },
    ] },
  },
  lastUpdated: false,
  sitemap: { hostname: 'https://laranex.github.io/node-schema-viewer/' },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#09090b' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Laranex Schema Viewer for Node.js' }],
  ],
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    lineNumbers: false,
    // docs/ is also read on GitHub, where links such as ../README.md work; on the site they point at the repository.
    config(md) {
      md.core.ruler.push('repository_links', (state) => {
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            const href = token.type === 'link_open' ? token.attrGet('href') : null
            if (href?.startsWith('../')) token.attrSet('href', `${repository}/blob/main/${href.slice(3)}`)
          }
        }
      })
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Laranex',
    nav: [
      { text: 'Node Schema Viewer', link: '/introduction' },
      { text: 'Live demo', link: '/demo' },
      { text: 'Laranex projects', link: 'https://laranex.vercel.app/' },
    ],
    sidebar: [
      { text: 'GET STARTED', items: [
        { text: 'Introduction', link: '/introduction' },
        { text: 'Installation', link: '/installation' },
        { text: 'Quick start', link: '/quick-start' },
        { text: 'Supported ORMs', link: '/orm-support' },
      ] },
      { text: 'WORK WITH YOUR SCHEMA', items: [
        { text: 'Build a snapshot', link: '/build' },
        { text: 'Database introspection', link: '/database' },
        { text: 'Multiple connections', link: '/connections' },
        { text: 'Schema comparison', link: '/comparison' },
        { text: 'Schema drift gate (CI)', link: '/check' },
        { text: 'Live demo', link: '/demo' },
      ] },
      { text: 'REFERENCE', items: [
        { text: 'CLI & configuration', link: '/cli' },
        { text: 'MCP for agents', link: '/mcp' },
        { text: 'Isolation & security', link: '/security' },
        { text: 'Agent skills', link: '/agent-skills' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
      ] },
    ],
    search: { provider: 'local', options: { detailedView: true } },
    outline: { level: [2, 3], label: 'On this page' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path`, text: 'Improve this page on GitHub' },
    footer: { message: 'Open source under the MIT license.', copyright: 'Laranex · Built by developers, for developers.' },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    externalLinkIcon: true,
  },
})
