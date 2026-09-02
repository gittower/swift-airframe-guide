// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import rehypeRaw from 'rehype-raw';
import rehypeBaseLinks from './src/utils/rehype-base-links.mjs';

// Hosted as a GitHub Pages project site under the gittower org:
// https://gittower.github.io/swift-airframe-guide/
// Move to a custom domain later (swiftairframe.dev / airframe.guide) by
// dropping `base` back to '/' and adding a public/CNAME file.
const base = '/swift-airframe-guide/';

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  site: 'https://gittower.github.io',
  base,
  markdown: {
    shikiConfig: {
      theme: 'css-variables',
    },
    // rehype-raw first: raw HTML embedded in markdown (the callout boxes,
    // the SVG diagram, cross-reference links) otherwise stays an opaque
    // "raw" string node, invisible to any rehype plugin that walks elements.
    rehypePlugins: [rehypeRaw, [rehypeBaseLinks, base]],
  },
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Overpass',
      cssVariable: '--font-display',
      weights: [400, 600, 700, 800],
      styles: ['normal'],
      subsets: ['latin'],
      formats: ['woff2'],
      fallbacks: ['Arial Narrow', 'Arial', 'sans-serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Source Serif 4',
      cssVariable: '--font-body',
      weights: [400, 500, 600],
      styles: ['normal', 'italic'],
      subsets: ['latin'],
      formats: ['woff2'],
      fallbacks: ['Georgia', 'Times New Roman', 'serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-mono',
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin'],
      formats: ['woff2'],
      fallbacks: ['SFMono-Regular', 'Consolas', 'monospace'],
    },
  ],
  integrations: [sitemap()],
});
