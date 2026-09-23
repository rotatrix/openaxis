// Render the canonical specification inside the SDK documentation.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// SPEC.md becomes the spec/ index.
export const DOCS = [
  { src: "SPEC.md", out: "index.html", nav: "Spec" },
];

const md = new MarkdownIt({ html: true, linkify: false }).use(anchor, {
  // Matches python-markdown's toc slugify (which SPEC.md's in-document links
  // were written against): strip punctuation, then each space → one hyphen.
  slugify: (s) =>
    s.trim().toLowerCase().replace(/[^\w\- ]+/g, "").replace(/ /g, "-"),
  permalink: anchor.permalink.linkInsideHeader({
    symbol: "¶",
    class: "headerlink",
    placement: "after",
  }),
});

// Rewrite cross-links between the source .md files to their rendered pages.
const mdLinkMap = new Map(DOCS.map((d) => [d.src, d.out]));
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href");
  if (href) {
    if (href === 'LICENSE') tokens[idx].attrSet('href', '/legal/license/');
    if (href === 'LEGAL.md') tokens[idx].attrSet('href', '/legal/');
    const guide = href.match(/^docs\/src\/content\/docs\/(.+)\.mdx?(#.*)?$/);
    if (guide) tokens[idx].attrSet("href", `${guide[1] === 'index' ? '/' : `/${guide[1]}/`}${guide[2] ?? ""}`);
    const m = href.match(/^([^#]+)(#.*)?$/);
    const mapped = m && mdLinkMap.get(m[1]);
    if (mapped) tokens[idx].attrSet("href", mapped + (m[2] ?? ""));
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Shared canonical-spec renderer: preserves the specification's existing IDs.
export function renderDocFragment(doc, source) {
  const src = source ?? readFileSync(resolve(ROOT, doc.src), "utf8");
  const env = {};
  const tokens = md.parse(src, env);
  const headings = tokens.flatMap((token, index) => token.type === 'heading_open'
    && Number(token.tag.slice(1)) > 1
    ? [{ depth: Number(token.tag.slice(1)), slug: token.attrGet('id'), text: tokens[index + 1].content }]
    : []);
  const h1 = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
  const title = h1 >= 0 ? tokens[h1 + 1].content : doc.src;
  const content = h1 >= 0 ? [...tokens.slice(0, h1), ...tokens.slice(h1 + 3)] : tokens;
  return { title, headings, body: md.renderer.render(content, md.options, env) };
}
