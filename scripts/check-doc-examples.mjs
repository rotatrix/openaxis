// Prevent page-wide language forks and silently empty source excerpts.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { sourceLink } from '../docs/src/source-files.mjs';

const content = fileURLToPath(new URL('../docs/src/content/docs/', import.meta.url));
function pages(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? pages(path) : path.endsWith('.mdx') ? [path] : [];
  });
}
let excerptCount = 0, tabCount = 0;
for (const path of pages(content)) {
  const text = readFileSync(path, 'utf8');
  for (const selector of text.matchAll(/<Tabs\s[^>]*syncKey="sdk-language"[^>]*>([\s\S]*?)<\/Tabs>/g)) {
    for (const language of ['Python', 'C#', 'TypeScript', 'C++']) {
      if (!selector[1].includes(`<TabItem label="${language}">`))
        throw new Error(`${path}: missing ${language} panel in SDK language selector`);
    }
  }
  for (const link of text.matchAll(/<SourceLink file="([^"]+)"(?: symbol="([^"]+)")?\s*\/>/g)) {
    sourceLink(link[1], link[2]);
  }
  let depth = 0, fenced = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (line.includes('<Tabs ')) { depth++; tabCount++; }
    if (depth && /^#{1,6}\s/.test(line)) {
      throw new Error(`${path}:${index + 1}: keep section headings outside language tabs`);
    }
    if (line.includes('</Tabs>')) depth--;
    if (depth < 0) throw new Error(`${path}: unmatched Tabs closing tag`);
  }
  if (depth) throw new Error(`${path}: unclosed Tabs`);
  const sources = {};
  for (const match of text.matchAll(/import (\w+) from ['"]([^'"]+)\?raw['"]/g)) {
    sources[match[1]] = readFileSync(resolve(dirname(path), match[2]), 'utf8');
  }
  for (const match of text.matchAll(/<Code\s+lang="[^"]+"\s+code=\{([^\n]+)\}\s*\/>/g)) {
    // Resolve source markers separately: slice(-1) could otherwise produce a
    // nonempty but incorrect excerpt when a source method has been renamed.
    for (const marker of match[1].matchAll(/(\w+)\.indexOf\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
      const value = runInNewContext(marker[2], {}, { timeout: 1000 });
      if (!sources[marker[1]]?.includes(value)) throw new Error(`${path}: missing source marker ${value}`);
    }
    const excerpt = runInNewContext(match[1], sources, { timeout: 1000 });
    if (typeof excerpt !== 'string' || !excerpt.trim()) throw new Error(`${path}: empty code excerpt`);
    excerptCount++;
  }
}
console.log(`Verified ${tabCount} local language selectors and ${excerptCount} source excerpts; all section headings remain shared.`);
