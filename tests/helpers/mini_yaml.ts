// Tiny YAML-subset reader + JSON-schema subset checker for the OpenAPI request-body tests (SEL-46).
// No new dependency (decision: "새 의존성 금지"). It reads what docs/api/openapi-v1.yaml uses: block
// maps and sequences, flow {} and [], quoted and plain scalars, "|" / ">" block text, comments.
// It is test code, not a general YAML parser; an unreadable construct throws so a test fails loudly.

type Node = unknown;

interface Line {
  indent: number;
  text: string;
  raw: string;
}

function strip_comment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // a quote only opens a string at the start of a token
      if (i === 0 || /[\s{[,:]/.test(text[i - 1])) quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function scalar(token: string): Node {
  const t = token.trim();
  if (t === "") return null;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return JSON.parse(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Split `a, b, {c: d}` at top-level commas. */
function split_top(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s{[,:]/.test(text[i - 1]))) quote = ch;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start);
  if (last.trim() !== "") out.push(last);
  return out;
}

function split_key(entry: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < entry.length; i += 1) {
    const ch = entry[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s{[,]/.test(entry[i - 1]))) quote = ch;
    else if (ch === ":" && (i === entry.length - 1 || entry[i + 1] === " ")) {
      return [entry.slice(0, i), entry.slice(i + 1)];
    }
  }
  throw new Error(`mini_yaml: no "key:" in ${JSON.stringify(entry)}`);
}

function flow(text: string): Node {
  const t = text.trim();
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw new Error(`mini_yaml: unterminated flow map ${t}`);
    const out: Record<string, Node> = {};
    let last: string | null = null;
    for (const entry of split_top(t.slice(1, -1))) {
      let pair: [string, string];
      try {
        pair = split_key(entry.trim());
      } catch (error) {
        // Lenient: the doc writes `{ description: a, b }` with commas inside a plain scalar.
        if (last !== null && typeof out[last] === "string") {
          out[last] = `${out[last] as string}, ${entry.trim()}`;
          continue;
        }
        throw error;
      }
      last = String(scalar(pair[0]));
      out[last] = flow(pair[1]);
    }
    return out;
  }
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new Error(`mini_yaml: unterminated flow list ${t}`);
    return split_top(t.slice(1, -1)).map((item) => flow(item));
  }
  return scalar(t);
}

export function parse_yaml(source: string): any {
  const lines: Line[] = [];
  const raw_lines = source.split(/\r?\n/);
  for (let i = 0; i < raw_lines.length; i += 1) {
    const raw = raw_lines[i];
    const text = strip_comment(raw);
    if (text.trim() === "") {
      lines.push({ indent: -1, text: "", raw });
      continue;
    }
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), raw });
  }
  let pos = 0;
  const skip_blank = () => {
    while (pos < lines.length && lines[pos].indent === -1) pos += 1;
  };

  function block_text(parent_indent: number): string {
    const parts: string[] = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent === -1) {
        parts.push("");
        pos += 1;
        continue;
      }
      if (line.indent <= parent_indent) break;
      parts.push(line.raw.trim());
      pos += 1;
    }
    return parts.join("\n").trimEnd();
  }

  function value_after(rest: string, indent: number): Node {
    const t = rest.trim();
    if (t === "|" || t === ">" || t === "|-" || t === ">-") return block_text(indent);
    if (t === "") {
      skip_blank();
      if (pos < lines.length && (lines[pos].indent > indent || (lines[pos].indent === indent && lines[pos].text.startsWith("- ")))) {
        return parse_block(lines[pos].indent);
      }
      return null;
    }
    return flow(t);
  }

  function parse_block(indent: number): Node {
    skip_blank();
    const first = lines[pos];
    if (first.text.startsWith("- ") || first.text === "-") {
      const list: Node[] = [];
      while (pos < lines.length) {
        skip_blank();
        if (pos >= lines.length) break;
        const line = lines[pos];
        if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;
        const rest = line.text === "-" ? "" : line.text.slice(2);
        // `- key: value` opens a map whose later keys sit at indent + 2
        if (rest !== "" && !rest.startsWith("{") && !rest.startsWith("[") && /^("[^"]*"|'[^']*'|[^\s"'{[][^:]*?):(\s|$)/.test(rest)) {
          lines[pos] = { indent: indent + 2, text: rest, raw: " ".repeat(indent + 2) + rest };
          list.push(parse_block(indent + 2));
        } else {
          pos += 1;
          list.push(value_after(rest, indent));
        }
      }
      return list;
    }
    const map: Record<string, Node> = {};
    while (pos < lines.length) {
      skip_blank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`mini_yaml: unexpected indent at ${JSON.stringify(line.raw)}`);
      if (line.text.startsWith("- ")) break;
      const [k, v] = split_key(line.text);
      pos += 1;
      map[String(scalar(k))] = value_after(v, indent);
    }
    return map;
  }

  skip_blank();
  return pos >= lines.length ? null : parse_block(lines[pos].indent);
}

// ---------------------------------------------------------------------------
// JSON-schema subset checker

export function resolve_ref(root: any, schema: any): any {
  let cur = schema;
  for (let guard = 0; cur !== null && typeof cur === "object" && typeof cur.$ref === "string"; guard += 1) {
    assert_guard(guard < 20, "$ref loop");
    const ref: string = cur.$ref;
    if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported: ${ref}`);
    cur = ref
      .slice(2)
      .split("/")
      .reduce((node: any, part) => {
        if (node === undefined || node === null) throw new Error(`dangling $ref ${ref}`);
        return node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      }, root);
    if (cur === undefined) throw new Error(`dangling $ref ${ref}`);
  }
  return cur;
}

function assert_guard(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function type_ok(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      throw new Error(`unsupported schema type ${type}`);
  }
}

/** Returns the list of violations; empty means the value passes. */
export function validate(root: any, schema_in: any, value: unknown, where = "$"): string[] {
  const schema = resolve_ref(root, schema_in);
  if (schema === true || schema === undefined || schema === null) return [];
  if (schema === false) return [`${where}: schema is false`];
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => type_ok(value, t))) errors.push(`${where}: expected ${types.join("|")}`);
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${where}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${where}: enum`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${where}: minLength`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${where}: maxLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: pattern`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${where}: minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${where}: maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${where}: minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${where}: maxItems`);
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...validate(root, schema.items, item, `${where}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) errors.push(`${where}: missing required ${name}`);
    }
    const props = schema.properties ?? {};
    for (const [name, v] of Object.entries(record)) {
      if (name in props) errors.push(...validate(root, props[name], v, `${where}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown field ${name}`);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        errors.push(...validate(root, schema.additionalProperties, v, `${where}.${name}`));
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) errors.push(...validate(root, sub, value, where));
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((sub: any) => validate(root, sub, value, where).length === 0)) errors.push(`${where}: anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter((sub: any) => validate(root, sub, value, where).length === 0).length;
    if (hits !== 1) errors.push(`${where}: oneOf matched ${hits}`);
  }
  return errors;
}
