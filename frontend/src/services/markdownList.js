// Pure list-marker helpers shared by the chat renderer and its tests.

export function parseListMarker(line) {
  const value = String(line || '');
  let match = value.match(/^(\s*)\**\s*(\d{1,4})\s*[.)]\s*\**\s+(.*)$/);
  if (match) {
    return { type: 'ol', indent: match[1].length, number: Number(match[2]), text: match[3] };
  }
  match = value.match(/^(\s*)\**\s*(\d{1,4})\s*:\**\s+(.*)$/);
  if (match) {
    return { type: 'ol', indent: match[1].length, number: Number(match[2]), text: match[3] };
  }
  match = value.match(/^(\s*)([-*•])\s+(.*)$/);
  if (match) return { type: 'ul', indent: match[1].length, text: match[3] };
  return null;
}

export function shouldKeepListAcrossBlank(lines, index, listType) {
  for (let i = index + 1; i < lines.length; i += 1) {
    if (!String(lines[i]).trim()) continue;
    const next = parseListMarker(lines[i]);
    return Boolean(next && next.type === listType && next.indent < 4);
  }
  return false;
}
