export const REDACTED = '[REDACTED]';
const names = '(?:password|passwd|api[_-]?key|access[_-]?token|token|secret|authorization)';
export const sensitiveName = new RegExp(`^${names}$`, 'i');
const boundary = /[\s,;}\]]/u;

function quoteEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === text[start]) return i + 1;
  }
  return -1;
}
function decodeQuoted(token: string): string {
  if (token[0] === '"') {
    try { return JSON.parse(token) as string; } catch { /* Plain text may use non-JSON escapes. */ }
  }
  return token.slice(1, -1).replace(/\\([\\"'])/g, '$1');
}
function encodeQuoted(value: string, quote: string): string {
  return quote === '"' ? JSON.stringify(value) : "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function containerEnd(text: string, start: number): number {
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      const end = quoteEnd(text, i); if (end < 0) return text.length; i = end - 1;
    } else if (char === '[' || char === '{') stack.push(char === '[' ? ']' : '}');
    else if (char === ']' || char === '}') {
      if (stack.pop() !== char) return text.length;
      if (!stack.length) return i + 1;
    }
  }
  return text.length;
}
function credentialValue(text: string, start: number, keyQuote: string): { end: number; replacement: string; secret: boolean } {
  const scheme = /^(?:Bearer|Basic)\s+/i.exec(text.slice(start))?.[0] ?? '';
  const valueStart = start + scheme.length;
  const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart]! : '';
  let end = valueStart; let value: string | undefined;
  if (quote) {
    end = quoteEnd(text, valueStart);
    if (end < 0) end = text.length; else value = decodeQuoted(text.slice(valueStart, end));
  } else if (text.startsWith(REDACTED, valueStart)) end += REDACTED.length;
  else if (text[valueStart] === '[' || text[valueStart] === '{') end = containerEnd(text, valueStart);
  // Interior quotes and contiguous suffixes belong to the credential, not to safe text.
  const beforeSuffix = end;
  while (end < text.length && !boundary.test(text[end]!)) end++;
  if (end === start) return { end, replacement: '', secret: false };
  const complete = quote && end === beforeSuffix && value !== undefined ? value : text.slice(valueStart, end);
  const secret = complete.replace(/^(?:Bearer|Basic)\s+/i, '') !== REDACTED;
  const replacement = quote || keyQuote ? encodeQuoted(REDACTED, quote || keyQuote) : REDACTED;
  return { end, replacement: secret ? replacement : text.slice(start, end), secret };
}

/** Scan quote boundaries before assignments, preserving JSON lexemes outside changed strings.
 * Decoding/re-encoding only changed string tokens keeps large numbers and layout intact.
 */
export function scanCredentials(text: string): { text: string; secret: boolean } {
  const tokens = new RegExp(`(\\b${names}\\s*[:=]\\s*)|["']`, 'gi');
  let cursor = 0; let result = ''; let secret = false;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const start = token.index; result += text.slice(cursor, start);
    let prefix = token[1]; let keyQuote = '';
    if (!prefix) {
      const end = quoteEnd(text, start);
      if (end < 0) { result += token[0]; cursor = start + 1; tokens.lastIndex = cursor; continue; }
      const original = text.slice(start, end); const decoded = decodeQuoted(original);
      const assignment = /^\s*[:=]\s*/.exec(text.slice(end))?.[0];
      if (sensitiveName.test(decoded) && assignment) {
        prefix = original + assignment; keyQuote = text[start]!;
      } else {
        const nested = scanCredentials(decoded); secret ||= nested.secret;
        result += nested.text === decoded ? original : encodeQuoted(nested.text, text[start]!);
        cursor = end; tokens.lastIndex = cursor; continue;
      }
    }
    const value = credentialValue(text, start + prefix.length, keyQuote);
    result += prefix + value.replacement; secret ||= value.secret;
    cursor = value.end; tokens.lastIndex = cursor;
  }
  return { text: result + text.slice(cursor), secret };
}
