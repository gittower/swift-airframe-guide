import { visit } from 'unist-util-visit';

/**
 * Prefixes internal absolute `href`s (starting with a single "/") with the
 * configured `base`, so links written as plain "/guide/..." inside markdown
 * content still resolve correctly when the site is served from a subpath
 * (e.g. GitHub Pages project sites: https://gittower.github.io/swift-airframe-guide/).
 *
 * Leaves protocol-relative ("//..."), absolute ("https://..."), and
 * fragment/mailto links untouched.
 */
export default function rehypeBaseLinks(base) {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;

  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a') return;
      const href = node.properties?.href;
      if (typeof href !== 'string') return;
      if (!href.startsWith('/') || href.startsWith('//')) return;
      node.properties.href = prefix + href;
    });
  };
}
