// Node names from a lookup table: FreeSurfer `id name r g b a`, MRtrix `id short long r g b a`.

export function parseLookup(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.match(/"[^"]*"|\S+/g) ?? [];
    const id = Number(tokens[0]);
    if (!Number.isInteger(id) || id < 0 || tokens.length < 2) continue;
    const name = tokens.slice(1);
    // Trailing colour columns are numeric. A table with no colours still names its nodes.
    while (name.length > 1 && /^-?\d+(\.\d+)?$/.test(name[name.length - 1]!)) name.pop();
    const picked = name.length > 1 ? name.slice(1).join(' ') : name[0]!;
    names.set(id, picked.replace(/^"|"$/g, ''));
  }
  return names;
}
