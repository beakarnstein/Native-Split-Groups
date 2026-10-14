/**
 * Comportamiento de arrastre en Kanban
 */
import { normalizeKey } from "./split";

export type DragMode = "replace-all" | "add" | "replace-origin";

export interface DragResult {
  value: unknown[];
  fallback: boolean;
  blank?: boolean;
}

const items = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v as unknown[];
  if (v === null || v === undefined || v === "") return [];
  return [v];
};

function keyOf(x: unknown, ci: boolean): string {
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean" || typeof x === "bigint") {
    return normalizeKey(String(x), ci);
  }
  return "";
}

/**
 * Intervención si la lista ahora tiene un único valor.
 */
export function isListToSingleValue(before: unknown[], after: unknown, ci = true): boolean {
  if (before.length === 0) return false;
  const now = items(after);
  if (now.length !== 1) return false;
  if (before.length === 1 && keyOf(before[0], ci) === keyOf(now[0], ci)) return false; // sin cambio
  return true;
}

/**
 * Decide el origen de la tarjeta comparando los textos de cabecera que la rodean
 * (del nivel más cercano al más lejano) con los valores que tenía la lista.
 * Devuelve el valor original de la lista, o undefined si es ambiguo o no hay coincidencia.
 */
export function matchOrigin(levels: string[][], before: unknown[], ci = true): unknown {
  const keys = before.map((b) => keyOf(b, ci));
  for (const level of levels) {
    const hit = new Set<number>();
    keys.forEach((k, i) => {
      if (k && level.includes(k)) hit.add(i);
    });
    if (hit.size === 1) return before[[...hit][0]];
    if (hit.size > 1) return undefined; // ambiguo
  }
  return undefined;
}

/**
 * @param before  lista antes de la escritura
 * @param after   valor que quiso escribir el Kanban (un solo valor)
 * @param origin  valor de la lista correspondiente a la columna de origen (si se conoce)
 * @returns null si no hay que intervenir (modo "replace-all")
 */
export function applyDragMode(
  mode: DragMode,
  before: unknown[],
  after: unknown,
  origin: unknown,
  ci = true,
): DragResult | null {
  if (mode === "replace-all") return null;

  const incoming = items(after)[0];
  const inKey = keyOf(incoming, ci);
  const beforeKeys = before.map((b) => keyOf(b, ci));
  const already = beforeKeys.includes(inKey);

  const add = (): unknown[] => (already ? [...before] : [...before, incoming]);

  if (mode === "add") return { value: add(), fallback: false };

  // mode === "replace-origin"
  const oi = origin === undefined ? -1 : beforeKeys.indexOf(keyOf(origin, ci));
  if (oi < 0) return { value: add(), fallback: true };
  if (beforeKeys[oi] === inKey) return { value: [...before], fallback: false }; // soltada en su propia columna
  if (already) return { value: before.filter((_, i) => i !== oi), fallback: false };
  return { value: before.map((x, i) => (i === oi ? incoming : x)), fallback: false };
}
/**
 * Arrastre a la columna «sin valor» (None): Obsidian borra la propiedad de la nota.
 *  - replace-all:    la propiedad queda en blanco (no se borra)
 *  - add:            no se cambia nada
 *  - replace-origin: se quita solo el valor de la columna de origen y se conserva el resto
 * @returns null si no hay que intervenir
 */
export function applyDragToNone(mode: DragMode, before: unknown[], origin: unknown, ci = true): DragResult | null {
  if (before.length === 0) return null;
  if (mode === "replace-all") return { value: [], fallback: false, blank: true };
  if (mode === "add") return { value: [...before], fallback: false };
  const oi = origin === undefined ? -1 : before.map((b) => keyOf(b, ci)).indexOf(keyOf(origin, ci));
  if (oi < 0) return { value: [...before], fallback: true };
  const rest = before.filter((_, i) => i !== oi);
  return { value: rest, fallback: false, blank: rest.length === 0 };
}
