// SEL-54 (보강) helper: strict reading of the config examples in the adapter notes.

/** Keys that appear twice in one JSON object (JSON.parse silently keeps the last one). Returns their dotted paths. */
export function json_duplicate_keys(text: string): string[] {
  const dups: string[] = [];
  const stack: Array<{ keys: Set<string>; path: string }> = [];
  let i = 0;
  const string_at = (at: number): [string, number] => {
    let j = at + 1;
    let out = "";
    for (; j < text.length; j += 1) {
      const ch = text[j]!;
      if (ch === '"') return [out, j + 1];
      if (ch === "\\") {
        out += text[j] + (text[j + 1] ?? "");
        j += 1;
      } else out += ch;
    }
    throw new SyntaxError("unterminated string");
  };
  let last_key = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{") {
      stack.push({ keys: new Set(), path: `${stack.at(-1)?.path ?? ""}/${last_key}` });
      i += 1;
    } else if (ch === "}") {
      stack.pop();
      i += 1;
    } else if (ch === '"') {
      const [value, next] = string_at(i);
      i = next;
      let k = i;
      while (/\s/.test(text[k] ?? "")) k += 1;
      if (text[k] === ":" && stack.length > 0) {
        const top = stack.at(-1)!;
        if (top.keys.has(value)) dups.push(`${top.path}/${value}`);
        top.keys.add(value);
        last_key = value;
      }
    } else i += 1;
  }
  return dups;
}
