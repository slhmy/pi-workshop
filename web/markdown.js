const MAX_INLINE_DEPTH = 8;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createIcon(name, className) {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  const use = document.createElementNS(SVG_NAMESPACE, "use");
  icon.setAttribute("class", `ui-icon ${className}`);
  icon.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `/icons.svg?v=1#${name}`);
  icon.append(use);
  return icon;
}

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

function safeLinkTarget(value) {
  const target = value.trim();
  if (!target) return null;
  if (target.startsWith("#")) return target;

  try {
    const url = new URL(target, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(parent, source, depth = 0) {
  if (!source) return;
  if (depth >= MAX_INLINE_DEPTH) {
    appendText(parent, source);
    return;
  }

  let index = 0;
  let plainStart = 0;
  const flush = (end) => {
    appendText(parent, source.slice(plainStart, end));
  };

  while (index < source.length) {
    const character = source[index];

    if (character === "\\" && index + 1 < source.length && "\\`*_[\]{}()#+-.!|>~".includes(source[index + 1])) {
      flush(index);
      appendText(parent, source[index + 1]);
      index += 2;
      plainStart = index;
      continue;
    }

    if (character === "`") {
      let markerLength = 1;
      while (source[index + markerLength] === "`") markerLength += 1;
      const marker = "`".repeat(markerLength);
      const end = source.indexOf(marker, index + markerLength);
      if (end !== -1) {
        flush(index);
        const code = document.createElement("code");
        code.textContent = source.slice(index + markerLength, end).replace(/\n/gu, " ");
        parent.append(code);
        index = end + markerLength;
        plainStart = index;
        continue;
      }
    }

    const pairedMarkers = [
      ["**", "strong"],
      ["__", "strong"],
      ["~~", "s"],
    ];
    let paired = false;
    for (const [marker, tag] of pairedMarkers) {
      if (!source.startsWith(marker, index)) continue;
      const end = source.indexOf(marker, index + marker.length);
      if (end <= index + marker.length) continue;
      flush(index);
      const element = document.createElement(tag);
      appendInline(element, source.slice(index + marker.length, end), depth + 1);
      parent.append(element);
      index = end + marker.length;
      plainStart = index;
      paired = true;
      break;
    }
    if (paired) continue;

    if ((character === "*" || character === "_") && source[index + 1] !== character) {
      const end = source.indexOf(character, index + 1);
      if (end > index + 1) {
        flush(index);
        const emphasis = document.createElement("em");
        appendInline(emphasis, source.slice(index + 1, end), depth + 1);
        parent.append(emphasis);
        index = end + 1;
        plainStart = index;
        continue;
      }
    }

    if (character === "[") {
      const labelEnd = source.indexOf("]", index + 1);
      if (labelEnd !== -1 && source[labelEnd + 1] === "(") {
        const targetEnd = source.indexOf(")", labelEnd + 2);
        if (targetEnd !== -1) {
          const label = source.slice(index + 1, labelEnd);
          const rawTarget = source.slice(labelEnd + 2, targetEnd).trim().split(/\s+["']/u, 1)[0];
          const href = safeLinkTarget(rawTarget);
          flush(index);
          if (href) {
            const link = document.createElement("a");
            link.href = href;
            appendInline(link, label, depth + 1);
            if (href.startsWith("http://") || href.startsWith("https://")) {
              link.target = "_blank";
              link.rel = "noopener noreferrer";
            }
            parent.append(link);
          } else {
            appendText(parent, label || rawTarget);
          }
          index = targetEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }

    if (character === "\n") {
      flush(index);
      parent.append(document.createElement("br"));
      index += 1;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  flush(source.length);
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);

  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignments(line) {
  const cells = splitTableRow(line);
  if (!cells.length || cells.some((cell) => !/^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function fenceMatch(line) {
  return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w.+-]*)\s*$/u);
}

function listMatch(line) {
  return line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/u);
}

function startsBlock(lines, index) {
  const line = lines[index] || "";
  if (!line.trim()) return true;
  if (fenceMatch(line)) return true;
  if (/^\s{0,3}#{1,6}\s+/u.test(line)) return true;
  if (/^\s{0,3}>/u.test(line)) return true;
  if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/u.test(line)) return true;
  if (listMatch(line)) return true;
  return index + 1 < lines.length && tableAlignments(lines[index + 1]) !== null && splitTableRow(line).length > 1;
}

function appendMarkdownBlocks(parent, source, depth = 0) {
  if (depth >= MAX_INLINE_DEPTH) {
    const paragraph = document.createElement("p");
    paragraph.textContent = source;
    parent.append(paragraph);
    return;
  }

  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceMatch(line);
    if (fence) {
      const markerCharacter = fence[1][0];
      const minimumLength = fence[1].length;
      const codeLines = [];
      index += 1;
      while (index < lines.length) {
        const closing = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*$/u);
        if (closing && closing[1][0] === markerCharacter && closing[1].length >= minimumLength) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[2]) code.dataset.language = fence[2];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      parent.append(pre);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      parent.append(element);
      index += 1;
      continue;
    }

    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/u.test(line)) {
      parent.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/u.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/u, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      appendMarkdownBlocks(quote, quoteLines.join("\n"), depth + 1);
      parent.append(quote);
      continue;
    }

    const firstListItem = listMatch(line);
    if (firstListItem) {
      const ordered = /^\d/u.test(firstListItem[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered) list.start = Number.parseInt(firstListItem[1], 10) || 1;

      while (index < lines.length) {
        const itemMatch = listMatch(lines[index]);
        if (!itemMatch || /^\d/u.test(itemMatch[1]) !== ordered) break;
        let itemText = itemMatch[2];
        const item = document.createElement("li");
        const task = itemText.match(/^\[([ xX])\]\s+(.+)$/u);
        if (task) {
          item.className = "task-item";
          const checked = task[1].toLowerCase() === "x";
          item.append(createIcon(checked ? "check-square" : "square", "task-marker"));
          itemText = task[2];
        }
        appendInline(item, itemText);
        list.append(item);
        index += 1;
      }
      parent.append(list);
      continue;
    }

    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    const headers = alignments ? splitTableRow(line) : [];
    if (alignments && headers.length === alignments.length) {
      const wrapper = document.createElement("div");
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      wrapper.className = "markdown-table";

      headers.forEach((value, cellIndex) => {
        const cell = document.createElement("th");
        cell.style.textAlign = alignments[cellIndex];
        appendInline(cell, value);
        headRow.append(cell);
      });
      head.append(headRow);
      table.append(head);
      index += 2;

      const body = document.createElement("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const values = splitTableRow(lines[index]);
        const row = document.createElement("tr");
        headers.forEach((_, cellIndex) => {
          const cell = document.createElement("td");
          cell.style.textAlign = alignments[cellIndex];
          appendInline(cell, values[cellIndex] || "");
          row.append(cell);
        });
        body.append(row);
        index += 1;
      }
      table.append(body);
      wrapper.append(table);
      parent.append(wrapper);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInline(paragraph, paragraphLines.join("\n"));
    parent.append(paragraph);
  }
}

export function renderMarkdown(container, source) {
  const fragment = document.createDocumentFragment();
  appendMarkdownBlocks(fragment, typeof source === "string" ? source : "");
  container.textContent = "";
  container.append(fragment);
}
