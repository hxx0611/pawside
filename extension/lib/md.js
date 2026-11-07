// Small markdown renderer for agent replies.
//
// Deliberately hand-written and tiny: the panel renders untrusted model output,
// so everything is escaped first and only a fixed set of inline patterns is
// re-introduced afterwards. No HTML passthrough, no remote scripts.

export const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>'
    );
}

/**
 * Render markdown to HTML. Always call with raw model text; escaping happens
 * here so callers can never forget it.
 */
export function renderMarkdown(src) {
  const lines = escapeHtml(String(src || "").replace(/\n{3,}/g, "\n\n")).split("\n");
  const out = [];
  let list = null;
  let inCode = false;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(line.replace(/^\s*([-*+])\s+/, ""))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      closeList();
      out.push("<hr>");
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

/** Pull the first JSON object/array out of a model reply. */
export function extractJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}