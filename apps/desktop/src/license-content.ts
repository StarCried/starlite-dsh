/** Small, text-only Markdown renderer for untrusted model license documents. */
export function renderLicenseContent(text: string): HTMLDivElement {
  const content = document.createElement("div");
  content.className = "license-content";
  content.tabIndex = 0;
  content.setAttribute("aria-label", "模型使用许可");
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    if (/^\s*```/u.test(line)) {
      const code = document.createElement("code");
      const block: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index]!)) block.push(lines[index++]!);
      code.textContent = block.join("\n");
      const pre = document.createElement("pre");
      pre.append(code);
      content.append(pre);
      index += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1]!.length + 2, 6)}`);
      appendInline(node, heading[2]!);
      content.append(node);
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      content.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const list = listItem(line);
    if (list) {
      const node = document.createElement(list.ordered ? "ol" : "ul");
      if (list.ordered && list.number !== 1) node.setAttribute("start", String(list.number));
      while (index < lines.length) {
        const item = listItem(lines[index]!);
        if (!item || item.ordered !== list.ordered) break;
        const entry = document.createElement("li");
        appendInline(entry, item.text);
        node.append(entry);
        index += 1;
      }
      content.append(node);
      continue;
    }
    const quoted = /^\s{0,3}>\s?(.*)$/u.exec(line);
    const paragraph = document.createElement(quoted ? "blockquote" : "p");
    const group = [quoted ? quoted[1]! : line];
    index += 1;
    while (index < lines.length && lines[index]!.trim()) {
      const next = lines[index]!;
      if (quoted) {
        const match = /^\s{0,3}>\s?(.*)$/u.exec(next);
        if (!match) break;
        group.push(match[1]!);
      } else {
        if (/^\s{0,3}(?:#{1,6}\s|>|```|[-*_]{3,}\s*$)/u.test(next) || listItem(next)) break;
        group.push(next);
      }
      index += 1;
    }
    appendInline(paragraph, group.join("\n"));
    content.append(paragraph);
  }
  return content;
}

function listItem(line: string): {ordered: boolean; number: number; text: string} | null {
  const match = /^\s{0,3}(?:[-+*]|(\d{1,6})[.)])\s+(.+)$/u.exec(line);
  return match ? {ordered: match[1] !== undefined, number: Number(match[1] ?? 1), text: match[2]!} : null;
}

function appendInline(parent: HTMLElement, text: string): void {
  const tokens = /\\([\\`*_[\]()#])|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/gu;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[1] !== undefined) parent.append(document.createTextNode(match[1]));
    else if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const url = safeLicenseUrl(match[4]);
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[3];
        parent.append(link);
      } else parent.append(document.createTextNode(match[0]));
    } else {
      const strong = match[5] ?? match[6];
      const emphasis = document.createElement(strong !== undefined ? "strong" : "em");
      emphasis.textContent = strong ?? match[7] ?? match[8]!;
      parent.append(emphasis);
    }
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

function safeLicenseUrl(value: string): string | null {
  if (/[\p{Cc}\s]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
