type Rec = Record<string, unknown>;

const SKIP = new Set([
  "app",
  "vault",
  "metadataCache",
  "workspace",
  "fileManager",
  "file",
  "files",
  "data",
  "entries",
  "containerEl",
  "contentEl",
  "scope",
  "parent",
  "parentEl",
  "leaf",
  "el",
  "dom",
]);

function isObj(v: unknown): v is Rec {
  return typeof v === "object" && v !== null;
}

function isDomNode(v: unknown): boolean {
  return typeof Node !== "undefined" && v instanceof Node;
}

const PROBE_FLAG = "__nsgProbe";

function isProbe(fn: unknown): fn is (this: object) => unknown {
  return typeof fn === "function" && (fn as unknown as Record<string, unknown>)[PROBE_FLAG] === true;
}

function dataValue(obj: object, key: string): unknown {
  const d: { value?: unknown; get?: (this: object) => unknown } | undefined = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return undefined;
  if ("value" in d) return d.value;
  return isProbe(d.get) ? d.get.call(obj) : undefined;
}

function dataProps(obj: object): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const key of Object.getOwnPropertyNames(obj)) {
    const d: { value?: unknown; get?: (this: object) => unknown } | undefined = Object.getOwnPropertyDescriptor(obj, key);
    if (!d) continue;
    if ("value" in d) out.push([key, d.value]);
    else if (isProbe(d.get)) out.push([key, d.get.call(obj)]);
  }
  return out;
}

function ctorName(v: object): string {
  return (v as { constructor?: { name?: string } }).constructor?.name ?? "?";
}

export function findGroupOrderPath(root: object, maxDepth = 5, budget = 4000): string[] | null {
  const seen = new Set<object>([root]);
  const queue: Array<[object, string[]]> = [[root, []]];
  let visited = 0;
  while (queue.length > 0 && visited < budget) {
    const next = queue.shift();
    if (!next) break;
    const [obj, path] = next;
    visited++;
    if (Array.isArray(dataValue(obj, "groupOrder"))) return path;
    if (path.length >= maxDepth) continue;
    for (const [key, value] of dataProps(obj)) {
      if (SKIP.has(key) || !isObj(value) || Array.isArray(value) || seen.has(value) || isDomNode(value)) continue;
      seen.add(value);
      queue.push([value, [...path, key]]);
    }
  }
  return null;
}

export function readGroupOrder(root: object, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = dataValue(cur, key);
  }
  return isObj(cur) ? dataValue(cur, "groupOrder") : undefined;
}

export function hideGroupOrder(root: object, path: readonly string[]): object {
  let stash: unknown;
  const wrap = (obj: object, depth: number): object =>
    new Proxy(obj, {
      get(target, prop, receiver): unknown {
        if (depth === path.length && prop === "groupOrder") return undefined;
        if (depth === 0 && prop === "groupedDataCache") return stash;
        const value: unknown = Reflect.get(target, prop, receiver);
        if (depth < path.length && prop === path[depth] && isObj(value)) return wrap(value, depth + 1);
        return value;
      },
      has(target, prop): boolean {
        if (depth === path.length && prop === "groupOrder") return false;
        if (depth === 0 && prop === "groupedDataCache") return stash !== undefined;
        return Reflect.has(target, prop);
      },
      set(_target, prop, value): boolean {
        if (depth === 0 && prop === "groupedDataCache") stash = value;
        return true;
      },
      defineProperty(): boolean {
        return true;
      },
      deleteProperty(): boolean {
        return true;
      },
    });
  return wrap(root, 0);
}

export function describeShape(root: object, maxDepth = 2, maxLines = 80): string[] {
  const lines: string[] = [];
  const seen = new Set<object>();
  const proto: unknown = Object.getPrototypeOf(root);
  if (isObj(proto)) lines.push(`[prototype ${ctorName(root)}] ${Object.getOwnPropertyNames(proto).join(", ")}`);
  const walk = (obj: object, path: string, depth: number) => {
    if (seen.has(obj)) return;
    seen.add(obj);
    for (const [key, value] of dataProps(obj)) {
      if (lines.length >= maxLines) return;
      const here = path ? `${path}.${key}` : key;
      if (!isObj(value)) {
        lines.push(`${here}: ${typeof value}`);
        continue;
      }
      lines.push(`${here}: ${Array.isArray(value) ? `array(${value.length})` : ctorName(value)}`);
      if (depth < maxDepth && !SKIP.has(key) && !Array.isArray(value) && !isDomNode(value)) walk(value, here, depth + 1);
    }
  };
  walk(root, "", 0);
  return lines;
}

export function installProbe(
  obj: object,
  key: string,
  onEvent: (op: "read" | "write", value: unknown) => void,
): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || !("value" in d) || !d.configurable || !d.writable) return false;
  let current: unknown = d.value;
  const get = function (): unknown {
    onEvent("read", current);
    return current;
  };
  (get as unknown as Record<string, unknown>)[PROBE_FLAG] = true;
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: d.enumerable,
    get,
    set(v: unknown) {
      current = v;
      onEvent("write", v);
    },
  });
  return true;
}

export function holderAt(root: object, path: readonly string[]): object | null {
  let cur: unknown = root;
  for (const key of path) {
    if (!isObj(cur)) return null;
    cur = dataValue(cur, key);
  }
  return isObj(cur) ? cur : null;
}
