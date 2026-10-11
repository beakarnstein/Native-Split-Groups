export type GroupSortMode = "native" | "az" | "za" | "most" | "fewest";

export interface SplitOptions {
  caseInsensitive: boolean;
  sortMode: GroupSortMode;
}

export interface ValueAdapter<V> {
  isList(v: V): boolean;
  items(v: V): V[];
  isNull(v: V): boolean;
  text(v: V): string;
}

export interface GroupLike<V, E> {
  key?: V;
  entries: E[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function normalizeKey(raw: string, caseInsensitive = true): string {
  let s = String(raw ?? "").trim();
  const link = /^!?\[\[([\s\S]*)\]\]$/.exec(s);
  if (link) {
    s = link[1];
    const pipe = s.indexOf("|");
    if (pipe >= 0) s = s.slice(0, pipe);
    const hash = s.indexOf("#");
    if (hash > 0) s = s.slice(0, hash);
    const slash = s.lastIndexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
    s = s.replace(/\.md$/i, "");
  } else if (s.startsWith("#")) {
    s = s.slice(1);
  }
  s = s.replace(/\s+/g, " ").trim();
  return caseInsensitive ? s.toLocaleLowerCase() : s;
}

interface Bucket<V, E> {
  key: V;
  label: string;
  firstSeen: number;
  entries: Map<string, E>;
}

export function splitGroups<V, E, G extends GroupLike<V, E>>(
  groups: G[],
  ordered: E[],
  pathOf: (e: E) => string,
  ad: ValueAdapter<V>,
  opts: SplitOptions,
  make: (template: G, key: V | undefined, entries: E[]) => G,
): G[] {
  if (!groups.some((g) => g.key !== undefined && ad.isList(g.key))) return groups;

  const position = new Map<string, number>();
  ordered.forEach((e, i) => position.set(pathOf(e), i));

  const buckets = new Map<string, Bucket<V, E>>();
  const noValue = new Map<string, E>();
  let noValueKey: V | undefined;
  let hasNoValueKey = false;
  let sawNoValueGroup = false;
  let counter = 0;

  const ensure = (id: string, key: V, label: string): Bucket<V, E> => {
    let b = buckets.get(id);
    if (!b) {
      b = { key, label, firstSeen: counter++, entries: new Map() };
      buckets.set(id, b);
    }
    return b;
  };

  const addNoValue = (g: G) => {
    for (const e of g.entries) noValue.set(pathOf(e), e);
  };

  for (const g of groups) {
    const key = g.key;
    if (key === undefined || ad.isNull(key)) {
      if (!hasNoValueKey) {
        noValueKey = key;
        hasNoValueKey = true;
      }
      sawNoValueGroup = true;
      addNoValue(g);
      continue;
    }
    const parts = ad.isList(key) ? ad.items(key) : [key];
    const usable = parts.filter((p) => !ad.isNull(p) && normalizeKey(ad.text(p), opts.caseInsensitive) !== "");
    if (usable.length === 0) {
      addNoValue(g); // lista vacía
      continue;
    }
    for (const p of usable) {
      const id = normalizeKey(ad.text(p), opts.caseInsensitive);
      const b = ensure(id, p, ad.text(p));
      for (const e of g.entries) b.entries.set(pathOf(e), e);
    }
  }

  const list = [...buckets.values()];
  switch (opts.sortMode) {
    case "az":
      list.sort((a, b) => collator.compare(a.label, b.label));
      break;
    case "za":
      list.sort((a, b) => collator.compare(b.label, a.label));
      break;
    case "most":
      list.sort((a, b) => b.entries.size - a.entries.size || collator.compare(a.label, b.label));
      break;
    case "fewest":
      list.sort((a, b) => a.entries.size - b.entries.size || collator.compare(a.label, b.label));
      break;
    default:
      list.sort((a, b) => a.firstSeen - b.firstSeen);
  }

  const inBaseOrder = (m: Map<string, E>): E[] =>
    [...m.entries()]
      .sort((a, b) => (position.get(a[0]) ?? Infinity) - (position.get(b[0]) ?? Infinity))
      .map(([, e]) => e);

  const template = groups[0];
  const out = list.map((b) => make(template, b.key, inBaseOrder(b.entries)));
  if (noValue.size > 0 || sawNoValueGroup) out.push(make(template, noValueKey, inBaseOrder(noValue)));
  return out;
}
