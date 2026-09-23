import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import mermaidBlocks from './plugins/mermaid-blocks.mjs';

export default defineConfig({
  site: 'https://openaxis.rotatrix.com',
  base: '/',
  // Allow extensionless Vite module URLs such as /demos/@vite/client through
  // the dev proxy. Static pages still build as directory index.html files.
  trailingSlash: 'ignore',
  vite: {
    server: {
      allowedHosts: true,
      watch: { usePolling: true, interval: 5000 },
      proxy: {
        '^/demos(?:/|$)': {
          target: 'http://localhost:5188',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  },
  redirects: {
    '/guide/overview/': '/',
    '/concepts/architecture/': '/guide/navigation-quickstart/#how-the-integration-works',
    '/guide/host-binding/': '/reference/navigation-hosts/',
    '/reference/host-binding/': '/reference/navigation-hosts/',
    '/reference/release-status/': '/reference/language-support/',
    '/guide/connection-lifecycle/': '/reference/connection-lifecycle/',
  },
  markdown: { processor: unified({ remarkPlugins: [mermaidBlocks] }) },
  integrations: [starlight({
    title: 'OpenAxis',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rotatrix/openaxis' }],
    description: 'Build application integrations with the OpenAxis SDKs.',
    components: { Head: './src/components/Head.astro' },
    customCss: ['./src/styles/docs.css'],
    sidebar: [
      { label: 'Start here', items: [
        { label: 'Overview', slug: 'index' }, { slug: 'guide/navigation-quickstart' },
        { slug: 'guide/axis-streaming' },
      ] },
      { label: 'Shared integration tasks', items: [
        { slug: 'guide/sdk-installation' }, { slug: 'guide/connection-shutdown' },
        { slug: 'guide/dynamic-tags' }, { slug: 'guide/session-logs' },
        { slug: 'guide/reloading-during-development' },
      ] },
      { label: 'Navigation features', items: [
        { slug: 'guide/diagnostics-logging' },
        { slug: 'guide/picking-pivots' }, { slug: 'guide/concurrent-input' },
        { slug: 'guide/object-manipulation' }, { slug: 'guide/free-camera' },
        { slug: 'guide/2d-navigation' },
        { slug: 'guide/asynchronous-hosts' },
        { slug: 'guide/validation' },
      ] },
      { label: 'Navigation concepts', collapsed: true, items: [
        { slug: 'concepts/coordinates' }, { slug: 'concepts/reconciliation' },
      ] },
      { label: 'UI guidance', collapsed: true, items: [
        { label: 'Pivot appearance (Navigation)', slug: 'experience/pivots-diagnostics' },
        { slug: 'experience/settings' },
      ] },
      { label: 'Reference', collapsed: true, items: [
        { label: 'Shared', items: [
        { slug: 'reference/connection-lifecycle' }, { slug: 'reference/language-support' },
        { slug: 'reference/sdk-logging' },
        { label: 'Protocol specification', link: '/spec/' },
        { slug: 'reference/migration-1-0' },
        ] },
        { label: 'Navigation', items: [
        { slug: 'reference/navigation-hosts' }, { slug: 'reference/diagnostics' },
        { slug: 'reference/diagnostic-events' }, { slug: 'reference/diagnostic-rendering' },
        ] },
      ] },
      { label: 'Contributing', collapsed: true, items: [
        { slug: 'contributing/sdk-architecture' }, { slug: 'contributing/documentation' },
        { slug: 'contributing/release-testing' },
      ] },
      { label: 'Interactive demos', link: '/demos/' },
      { label: 'Legal', items: [
        { label: 'Legal notices', link: '/legal/' },
        { label: 'Licenses (ELv2 / GPLv3)', link: '/legal/license/' },
      ] },
    ],
  })],
});
