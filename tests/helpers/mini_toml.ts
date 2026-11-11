// SEL-54 helper: a tiny TOML reader for the Codex config example (no dependency is added to the repo).
// It reads only what a `[mcp_servers.<name>]` block needs: comments, [dotted.tables], key = "string" |
// ["string", ...] | { key = "string", ... } | true/false | integer. Anything else throws, so a doc example that
// leaves this subset fails loudly instead of being half-read.

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

function read_string(text: string, at: number): [string, number] {
  // basic string: "..." with \\ \" \n \t \uXXXX escapes; literal string: '...'
  const quote = text[at];
  let i = at + 1;
  let out = "";
  if (quote === "'") {
    const end = text.indexOf("'", i);
    if (end < 0) throw new SyntaxError("unterminated literal string");
    return [text.slice(i, end), end + 1];
  }
  for (; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') return [out, i + 1];
    if (ch === "\\") {
      const next = text[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "\\" || next === '"') out += next;
      else if (next === "u") {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else throw new SyntaxError(`unsupported escape \\${next}`);
    } else out += ch;
  }
  throw new SyntaxError("unterminated string");
}

function skip_space(text: string, at: number, newlines: boolean): number {
  let i = at;
  for (;;) {
    const ch = text[i];
    if (ch === " " || ch === "\t") i += 1;
    else if (newlines && (ch === "\n" || ch === "\r")) i += 1;
    else if (newlines && ch === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else return i;
  }
}

function read_key(text: string, at: number): [string, number] {
  if (text[at] === '"' || text[at] === "'") return read_string(text, at);
  const m = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
  if (m === null) throw new SyntaxError(`bad key at ${at}`);
  return [m[0], at + m[0].length];
}

function read_value(text: string, at: number): [TomlValue, number] {
  const i = skip_space(text, at, false);
  const ch = text[i];
  if (ch === '"' || ch === "'") return read_string(text, i);
  if (ch === "[") {
    const items: TomlValue[] = [];
    let j = skip_space(text, i + 1, true);
    while (text[j] !== "]") {
      const [value, next] = read_value(text, j);
      items.push(value);
      j = skip_space(text, next, true);
      if (text[j] === ",") j = skip_space(text, j + 1, true);
      else if (text[j] !== "]") throw new SyntaxError(`array expects , or ] at ${j}`);
    }
    return [items, j + 1];
  }
  if (ch === "{") {
    const table: { [key: string]: TomlValue } = {};
    let j = skip_space(text, i + 1, false);
    while (text[j] !== "}") {
      const [key, after_key] = read_key(text, j);
      j = skip_space(text, after_key, false);
      if (text[j] !== "=") throw new SyntaxError("inline table expects =");
      const [value, next] = read_value(text, j + 1);
      table[key] = value;
      j = skip_space(text, next, false);
      if (text[j] === ",") j = skip_space(text, j + 1, false);
      else if (text[j] !== "}") throw new SyntaxError(`inline table expects , or } at ${j}`);
    }
    return [table, j + 1];
  }
  const m = /^(true|false|-?[0-9]+)(?![A-Za-z0-9_.])/.exec(text.slice(i));
  if (m === null) throw new SyntaxError(`unsupported value at ${i}`);
  const raw = m[1]!;
  return [raw === "true" ? true : raw === "false" ? false : Number(raw), i + raw.length];
}

export function parse_toml(source: string): { [key: string]: TomlValue } {
  const text = source.replace(/\r\n/g, "\n");
  const root: { [key: string]: TomlValue } = {};
  let table = root;
  let i = 0;
  while (i < text.length) {
    i = skip_space(text, i, true);
    if (i >= text.length) break;
    if (text[i] === "[") {
      if (text[i + 1] === "[") throw new SyntaxError("array of tables is outside the subset");
      i += 1;
      table = root;
      for (;;) {
        i = skip_space(text, i, false);
        const [name, next] = read_key(text, i);
        i = skip_space(text, next, false);
        const existing = table[name];
        if (existing === undefined) table[name] = {};
        else if (typeof existing !== "object" || Array.isArray(existing)) throw new SyntaxError(`${name} is not a table`);
        table = table[name] as { [key: string]: TomlValue };
        if (text[i] === ".") {
          i += 1;
          continue;
        }
        if (text[i] !== "]") throw new SyntaxError(`table header expects ] at ${i}`);
        i += 1;
        break;
      }
    } else {
      const [key, next] = read_key(text, i);
      i = skip_space(text, next, false);
      if (text[i] !== "=") throw new SyntaxError(`key ${key} expects =`);
      const [value, after] = read_value(text, i + 1);
      if (key in table) throw new SyntaxError(`duplicate key ${key}`);
      table[key] = value;
      i = skip_space(text, after, false);
    }
    if (i < text.length && text[i] !== "\n" && text[i] !== "#") throw new SyntaxError(`trailing text at ${i}`);
  }
  return root;
}
