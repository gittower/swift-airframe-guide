// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  // TODO: update once a domain is registered (candidates: swiftairframe.dev, airframe.guide)
  site: 'https://swift-airframe-guide.pages.dev',
  markdown: {
    shikiConfig: {
      theme: 'css-variables',
    },
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
