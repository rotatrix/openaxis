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
    '/guide/navigation-quickstart/': '/getting-started/quickstart/',
    '/guide/navigation-integration/': '/getting-started/walkthrough/',
    '/guide/planning-integration/': '/getting-started/planning/',
    '/getting-started/checklist/': '/guide/validation/',
    '/guide/axis-streaming/': '/getting-started/axis-streaming/',
    '/guide/diagnostics-logging/': '/guide/diagnostics/',
    '/reference/migration-1-0/': '/guide/migrate-to-1-0/',
    '/experience/settings/': '/recommendations/settings-and-controls/',
    '/experience/pivots-diagnostics/': '/recommendations/pivot-appearance/',
    '/guide/overview/': '/',
    '/concepts/architecture/': '/getting-started/walkthrough/#how-the-integration-works',
    '/guide/host-binding/': '/reference/navigation-hosts/',
    '/reference/host-binding/': '/reference/navigation-hosts/',
    '/reference/release-status/': '/reference/language-support/',
    '/guide/connection-lifecycle/': '/reference/connection-lifecycle/',
    '/recipes/install-sdk/': '/guide/sdk-installation/',
    '/recipes/connection-lifecycle/': '/guide/connection-shutdown/',
    '/recipes/context-and-focus/': '/guide/dynamic-tags/',
    '/recipes/session-logs/': '/guide/session-logs/',
    '/recipes/diagnostics/': '/guide/diagnostics/',
    '/recipes/picking-and-pivots/': '/guide/picking-pivots/',
    '/recipes/concurrent-input/': '/guide/concurrent-input/',
    '/recipes/object-manipulation/': '/guide/object-manipulation/',
    '/recipes/free-camera/': '/guide/free-camera/',
    '/recipes/2d-navigation/': '/guide/2d-navigation/',
    '/recipes/asynchronous-apis/': '/guide/asynchronous-hosts/',
    '/recipes/development-reload/': '/guide/reloading-during-development/',
    '/recipes/migrate-to-1-0/': '/guide/migrate-to-1-0/',
    '/guidance/settings-and-controls/': '/recommendations/settings-and-controls/',
    '/guidance/pivot-appearance/': '/recommendations/pivot-appearance/',
  },
  markdown: { processor: unified({ remarkPlugins: [mermaidBlocks] }) },
  integrations: [starlight({
    title: 'OpenAxis',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rotatrix/openaxis' }],
    description: 'Build application integrations with the OpenAxis SDKs.',
    components: {
      Head: './src/components/Head.astro',
      SiteTitle: './src/components/SiteTitle.astro',
    },
    sidebar: [
      { label: 'Getting started', items: [
        { label: 'Overview', slug: 'index' }, { slug: 'getting-started/quickstart' },
        { slug: 'getting-started/walkthrough' }, { slug: 'getting-started/planning' },
        { label: 'Axis Streaming', slug: 'getting-started/axis-streaming' },
      ] },
      { label: 'Recipes', items: [
        { slug: 'guide/sdk-installation' },
        { slug: 'guide/connection-shutdown' }, { slug: 'guide/dynamic-tags' },
        { slug: 'guide/session-logs' }, { slug: 'guide/diagnostics' },
        { slug: 'guide/picking-pivots' }, { slug: 'guide/concurrent-input' },
        { slug: 'guide/object-manipulation' }, { slug: 'guide/free-camera' },
        { slug: 'guide/2d-navigation' }, { slug: 'guide/asynchronous-hosts' },
        { slug: 'guide/reloading-during-development' }, { slug: 'guide/migrate-to-1-0' },
        { slug: 'guide/validation' },
      ] },
      { label: 'Concepts', collapsed: true, items: [
        { slug: 'concepts/coordinates' }, { slug: 'concepts/reconciliation' },
      ] },
      { label: 'Recommendations', collapsed: true, items: [
        { label: 'Pivot appearance (Navigation)', slug: 'recommendations/pivot-appearance' },
        { slug: 'recommendations/settings-and-controls' },
      ] },
      { label: 'Reference', collapsed: true, items: [
        { label: 'Protocol specification', link: '/spec/' },
        { label: 'Shared', items: [
        { slug: 'reference/connection-lifecycle' }, { slug: 'reference/language-support' },
        { slug: 'reference/sdk-logging' },
        ] },
        { label: 'Navigation', items: [
        { slug: 'reference/navigation-coordination' },
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
