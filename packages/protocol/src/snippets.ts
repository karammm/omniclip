// Snippets: reusable text, stored on the hub (end-to-end encrypted), pasted from the desktop picker
// and copied on phones.

/** The fields of a decrypted snippet these helpers use. */
interface PlainSnippet {
  name?: string;
  keyword?: string;
  text: string;
}

/** Keywords are short words typed after ";" in the picker, e.g. ";addr". */
export function normalizeKeyword(keyword: string | undefined): string {
  return (keyword ?? '').trim().replace(/^;+/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/**
 * Snippets matching what was typed in the picker. ";" alone lists them all; ";ad" matches keywords
 * starting with "ad"; other text matches names, keywords and contents. Nothing typed: none.
 */
export function matchSnippets<S extends PlainSnippet>(snippets: S[], query: string): S[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byName = (a: S, b: S) => (a.name ?? '').localeCompare(b.name ?? '');
  if (q.startsWith(';')) {
    const k = normalizeKeyword(q);
    return snippets.filter((s) => normalizeKeyword(s.keyword).startsWith(k)).sort(byName);
  }
  const score = (s: S) => {
    if (normalizeKeyword(s.keyword) === q) return 0;
    if ((s.name ?? '').toLowerCase().startsWith(q)) return 1;
    if ((s.name ?? '').toLowerCase().includes(q) || normalizeKeyword(s.keyword).includes(q)) return 2;
    return s.text.toLowerCase().includes(q) ? 3 : -1;
  };
  return snippets
    .map((s) => [score(s), s] as const)
    .filter(([n]) => n >= 0)
    .sort((a, b) => a[0] - b[0] || byName(a[1], b[1]))
    .map(([, s]) => s);
}

/** Fills in {date}, {time} and {clipboard}. `{{` and `}}` stay as literal braces. */
export function expandSnippet(text: string, clipboardText: string, now = new Date()): string {
  const values: Record<string, string> = {
    date: now.toLocaleDateString(),
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    clipboard: clipboardText,
  };
  return text.replace(/\{\{|\}\}|\{(date|time|clipboard)\}/g, (m, name?: string) => (m === '{{' ? '{' : m === '}}' ? '}' : values[name!]!));
}
