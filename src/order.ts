
import { GroupLike, ValueAdapter, normalizeKey } from "./split";

export const NO_VALUE = "\u0000none";

export interface OrderEntry {
  key: string;
  label: string | null;
}

export function parseGroupOrder(raw: unknown, caseInsensitive: boolean): OrderEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: OrderEntry[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string | null) => {
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ key, label });
    }
  };
  const one = (x: unknown) => {
    if (x === null || x === undefined) return push(NO_VALUE, null);
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      const k = normalizeKey(String(x), caseInsensitive);
      if (k !== "") push(k, String(x));
    }
  };
  for (const item of raw as unknown[]) {
    if (Array.isArray(item)) {
      if (item.length === 0) push(NO_VALUE, null);
      else if (item.length === 1) one(item[0] as unknown);
    } else {
      one(item);
    }
  }
  return out;
}

export function normalizeGroupOrder(raw: unknown, caseInsensitive: boolean): string[] | null {
  return parseGroupOrder(raw, caseInsensitive)?.map((e) => e.key) ?? null;
}

function keyOfGroup<V, E>(g: GroupLike<V, E>, ad: ValueAdapter<V>, caseInsensitive: boolean): string {
  return g.key === undefined || ad.isNull(g.key) ? NO_VALUE : normalizeKey(ad.text(g.key), caseInsensitive);
}

export interface MenuGroup<V> {
  key: V | null;
  label: string | null;
  count: number;
  isVisible: boolean;
}

export function menuGroups<V>(
  values: ReadonlyArray<V | null | undefined>,
  order: OrderEntry[],
  ad: ValueAdapter<V>,
  caseInsensitive: boolean,
): MenuGroup<V>[] {
  const seen = new Map<string, { key: V | null; label: string | null; count: number }>();
  const add = (norm: string, key: V | null, label: string | null) => {
    const s = seen.get(norm);
    if (s) s.count++;
    else seen.set(norm, { key, label, count: 1 });
  };
  for (const v of values) {
    if (v === null || v === undefined || ad.isNull(v)) {
      add(NO_VALUE, null, null);
    } else if (ad.isList(v)) {
      const items = ad.items(v);
      if (items.length === 0) add(NO_VALUE, null, null);
      const done = new Set<string>();
      for (const it of items) {
        if (ad.isNull(it)) continue;
        const k = normalizeKey(ad.text(it), caseInsensitive);
        if (k === "" || done.has(k)) continue;
        done.add(k);
        add(k, it, ad.text(it));
      }
    } else {
      const k = normalizeKey(ad.text(v), caseInsensitive);
      if (k === "") add(NO_VALUE, null, null);
      else add(k, v, ad.text(v));
    }
  }
  const visible: MenuGroup<V>[] = [];
  const listed = new Set<string>();
  for (const o of order) {
    if (listed.has(o.key)) continue;
    listed.add(o.key);
    const s = seen.get(o.key);
    visible.push({ key: s ? s.key : null, label: s ? s.label : o.label, count: s ? s.count : 0, isVisible: true });
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const hidden = [...seen.entries()]
    .filter(([k]) => !listed.has(k))
    .map(([, s]) => ({ key: s.key, label: s.label, count: s.count, isVisible: false }))
    .sort((a, b) => collator.compare(a.label ?? "", b.label ?? ""));
  return visible.concat(hidden);
}

export function withEmptyColumns<V, E, G extends GroupLike<V, E>>(
  groups: G[],
  order: OrderEntry[],
  ad: ValueAdapter<V>,
  caseInsensitive: boolean,
  makeEmpty: (label: string | null) => G | null,
): G[] {
  const byKey = new Map<string, G>();
  for (const g of groups) {
    const k = keyOfGroup(g, ad, caseInsensitive);
    if (!byKey.has(k)) byKey.set(k, g);
  }
  const out: G[] = [];
  const done = new Set<string>();
  let hit = false;
  for (const o of order) {
    if (done.has(o.key)) continue;
    done.add(o.key);
    const g = byKey.get(o.key);
    if (g) {
      out.push(g);
      hit = true;
    } else {
      const empty = makeEmpty(o.label);
      if (empty) out.push(empty);
    }
  }
  return hit ? out : groups;
}

export function applyGroupOrder<V, E, G extends GroupLike<V, E>>(
  groups: G[],
  order: string[],
  ad: ValueAdapter<V>,
  caseInsensitive: boolean,
): G[] {
  if (order.length === 0) return [];
  const index = new Map<string, number>();
  order.forEach((k, i) => index.set(k, i));
  const keyOf = (g: G): string => keyOfGroup(g, ad, caseInsensitive);

  const shown = groups
    .map((g, i) => ({ g, i, k: index.get(keyOf(g)) }))
    .filter((x): x is { g: G; i: number; k: number } => x.k !== undefined);
  if (shown.length === 0) return groups;
  return shown.sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.g);
}

export function listHoldsKey<V>(list: V, key: V, ad: ValueAdapter<V>, caseInsensitive: boolean): boolean {
  if (!ad.isList(list) || ad.isNull(key)) return false;
  const norm = (v: V) => normalizeKey(ad.text(v), caseInsensitive);
  const wanted = (ad.isList(key) ? ad.items(key) : [key]).map(norm).filter((k) => k !== "");
  if (wanted.length === 0) return false;
  const own = new Set(ad.items(list).map(norm));
  return wanted.some((k) => own.has(k));
}
