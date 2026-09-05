import { ScheduleError } from './errors.js';

// JSON.parseの前に重複key（escape表記も含む）と非整数number tokenを拒否する。
export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65_536) throw new ScheduleError('invalid_json');
  let i = 0;
  const fail = (): never => { throw new ScheduleError('invalid_json'); };
  const space = () => { while (/[\t\n\r ]/.test(text[i] ?? 'x')) i++; };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '\\') i++;
      else if (ch === '"') {
        try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail(); }
      }
    }
    return fail();
  }
  function value(depth: number): void {
    if (depth > 32) fail();
    space();
    const ch = text[i];
    if (ch === '"') { string(); return; }
    if (ch === '{' || ch === '[') {
      i++;
      const end = ch === '{' ? '}' : ']';
      const keys = new Set<string>();
      space();
      if (text[i] === end) { i++; return; }
      while (true) {
        space();
        if (ch === '{') {
          if (text[i] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key);
          space();
          if (text[i++] !== ':') fail();
        }
        value(depth + 1);
        space();
        if (text[i] === end) { i++; return; }
        if (text[i++] !== ',') fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*))/.exec(text.slice(i))?.[0];
    if (!token) fail();
    i += token!.length;
    if (/^-?\d/.test(token!) && !Number.isSafeInteger(Number(token))) fail();
  }
  value(0);
  space();
  if (i !== text.length) fail();
  try { return JSON.parse(text); } catch { return fail(); }
}

export function canonicalJson(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)]));
    }
    return input;
  }
  return `${JSON.stringify(sort(value))}\n`;
}
