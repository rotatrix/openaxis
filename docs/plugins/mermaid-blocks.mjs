// Keep diagrams in Markdown. Only diagram pages load the Mermaid runtime.
export default function mermaidBlocks() {
  return function transform(tree) {
    function visit(node) {
      if (node.type === 'code' && node.lang === 'mermaid') {
        const escaped = node.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        node.type = 'html';
        node.value = `<pre class="mermaid" data-pagefind-ignore>${escaped}</pre>`;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
