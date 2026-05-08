import { marked } from 'marked';

// Escape raw HTML in markdown for security
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }: { text: string }) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
});

// Post-markdown sanitization: remove javascript: URLs from links
export function sanitizeHtml(html: string): string {
  return html
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript|data):[^"]*"/gi, ' href="#"')
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript|data):[^']*'/gi, " href='#'")
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript|data):[^\s>"]+/gi, ' href="#"');
}

export function parseMarkdown(content: string): string {
  if (!content) return '';
  const result = marked.parse(content);
  const html = typeof result === 'string' ? result : '';
  return sanitizeHtml(html);
}
