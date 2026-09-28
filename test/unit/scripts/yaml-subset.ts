/**
 * A tiny YAML subset parser for asserting workflow structure without a YAML dependency.
 * Supports: block maps and sequences (including `- key: value` items), full-line comments,
 * `|`/`>` block scalars, single/double-quoted scalars, flow sequences of scalars `[a, b]`,
 * booleans, null and integers. Anything else (anchors, flow maps, tabs, inline comments after a
 * value, duplicate keys) throws, so workflows stay in a subset these tests can read exactly.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parseYamlSubset(src: string): YamlValue {
  const raw = src.replace(/\r\n/g, '\n').split('\n');
  const lines: (Line | null)[] = raw.map((l, i) => {
    if (/^\s*\t/.test(l)) throw new Error(`line ${i + 1}: tabs are not allowed`);
    const text = l.trim();
    if (text === '' || text.startsWith('#')) return null;
    return { indent: l.length - l.trimStart().length, text, no: i + 1 };
  });
  let pos = 0;

  const peek = (): Line | undefined => {
    while (pos < lines.length && lines[pos] === null) pos++;
    return lines[pos] ?? undefined;
  };
  const isSeqItem = (t: string): boolean => t === '-' || t.startsWith('- ');
  const fail = (l: Line, msg: string): never => {
    throw new Error(`line ${l.no}: ${msg}`);
  };

  function scalar(s: string, l: Line): YamlValue {
    if (s.startsWith('"') || s.startsWith("'")) {
      const q = s[0] as string;
      if (!s.endsWith(q) || s.length < 2) fail(l, `unterminated string ${s}`);
      const body = s.slice(1, -1);
      return q === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'");
    }
    if (s.startsWith('[')) {
      if (!s.endsWith(']')) fail(l, 'unterminated flow sequence');
      const inner = s.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((p) => scalar(p.trim(), l));
    }
    if (s.startsWith('{') || s.startsWith('&') || s.startsWith('*')) fail(l, `unsupported syntax: ${s}`);
    if (/\s#/.test(s)) fail(l, 'inline comments are not supported');
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }

  function blockScalar(parentIndent: number, folded: boolean): string {
    const body: string[] = [];
    let base = -1;
    while (pos < raw.length) {
      const l = raw[pos] as string;
      const ind = l.length - l.trimStart().length;
      if (l.trim() !== '' && ind <= parentIndent) break;
      if (l.trim() !== '' && base < 0) base = ind;
      body.push(l);
      pos++;
    }
    while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop();
    const lines2 = body.map((l) => l.slice(Math.max(base, 0)));
    return folded ? lines2.join(' ') + '\n' : lines2.join('\n') + '\n';
  }

  function node(minIndent: number): YamlValue {
    const l = peek();
    if (!l || l.indent < minIndent) return null;
    return isSeqItem(l.text) ? seq(l.indent) : map(l.indent);
  }

  function value(rest: string, l: Line): YamlValue {
    pos++;
    if (rest === '|' || rest === '>') return blockScalar(l.indent, rest === '>');
    if (rest !== '') return scalar(rest, l);
    const next = peek();
    if (!next) return null;
    if (next.indent > l.indent) return node(l.indent + 1);
    if (next.indent === l.indent && isSeqItem(next.text)) return seq(l.indent);
    return null;
  }

  function map(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (let l = peek(); l && l.indent === indent && !isSeqItem(l.text); l = peek()) {
      const m = /^("[^"]*"|'[^']*'|[^:\s][^:]*?):(?:\s+(.*))?$/.exec(l.text);
      if (!m) fail(l, `expected "key: value", got ${l.text}`);
      const key = String(scalar((m as RegExpExecArray)[1] as string, l));
      if (Object.hasOwn(out, key)) fail(l, `duplicate key ${key}`);
      out[key] = value(((m as RegExpExecArray)[2] ?? '').trim(), l);
    }
    const l = peek();
    if (l && l.indent > indent) fail(l, 'unexpected indentation');
    return out;
  }

  function seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (let l = peek(); l && l.indent === indent && isSeqItem(l.text); l = peek()) {
      const content = l.text === '-' ? '' : l.text.slice(2).trim();
      if (content === '') {
        pos++;
        out.push(node(indent + 1));
      } else if (/^("[^"]*"|'[^']*'|[^:\s"'[][^:]*?):(\s|$)/.test(content)) {
        // `- key: value` starts a map whose keys sit two columns right of the dash.
        lines[pos] = { indent: indent + 2, text: content, no: l.no };
        out.push(map(indent + 2));
      } else {
        pos++;
        out.push(scalar(content, l));
      }
    }
    return out;
  }

  const result = node(0);
  const rest = peek();
  if (rest) fail(rest, 'unexpected content');
  return result;
}
