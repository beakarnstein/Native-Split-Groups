import {
  apiVersion,
  App,
  BasesEntry,
  BasesEntryGroup,
  BasesQueryResult,
  getLanguage,
  ListValue,
  Notice,
  NullValue,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  StringValue,
  TFile,
  Value,
  WorkspaceLeaf,
} from "obsidian";
import { ValueAdapter, normalizeKey, splitGroups } from "./split";
import { DragMode, applyDragMode, applyDragToNone, isListToSingleValue, matchOrigin } from "./drag";
import { makeT } from "./i18n";
import { describeShape, findGroupOrderPath, hideGroupOrder, holderAt, installProbe, readGroupOrder } from "./config";
import { NO_VALUE, applyGroupOrder, listHoldsKey, menuGroups, parseGroupOrder, withEmptyColumns } from "./order";

const t = makeT(() => getLanguage());

interface Settings {
  enabled: boolean;
  caseInsensitive: boolean;
  sortMode: PluginSortMode;
  dragMode: DragMode;
  debug: boolean;
}

const DEFAULTS: Settings = {
  enabled: true,
  caseInsensitive: true,
  sortMode: "native",
  dragMode: "replace-all",
  debug: false,
};

/** Clave con la que cada vista Kanban guarda su modo de arrastre en el archivo .base. */
const VIEW_DRAG_KEY = "splitGroupsDragMode";
/** Opción por vista: listar en el menú Group todas las opciones de la propiedad (solo con orden manual). */
const VIEW_ALL_OPTIONS_KEY = "splitGroupsAllOptions";
const BASES_CONTAINER = '.bases-view, .bases-embed, .workspace-leaf-content[data-type="bases"]';

interface DragState {
  /** Vista Kanban de origen (para cancelar su movimiento provisional). */
  view: Record<string, unknown> | null;
  /** Modo de arrastre que rige en la vista Kanban de origen. */
  mode: DragMode;
  start: number;
  end: number;
  levels: string[][];
}

interface ListLike {
  length: () => number;
  get: (index: number) => Value;
}

interface TypedDescriptor {
  configurable?: boolean;
  enumerable?: boolean;
  get?: (this: unknown) => unknown;
}

type Frontmatter = Record<string, unknown>;

type ProcessFn = (
  this: unknown,
  file: unknown,
  fn: (frontmatter: Frontmatter) => unknown,
  options?: unknown,
) => unknown;

interface BasesController {
  viewName?: unknown;
  query?: { getViewConfig?: (name: unknown) => unknown };
  results?: { values?: () => Iterable<BasesEntry> };
}

interface KanbanLike {
  data?: { data?: unknown; groupedData?: unknown };
  config?: unknown;
  orderedGroups?: BasesEntryGroup[];
  isManualSort?: unknown;
}

interface PatchedMethod {
  proto: Record<string, unknown>;
  name: string;
  original: unknown;
  wrapper: unknown;
}

interface LeafRebuild {
  rebuildView?: () => unknown;
}

type PluginSortMode = "native" | "most" | "fewest";
const SORT_MODES: readonly PluginSortMode[] = ["native", "most", "fewest"];

function isSortMode(v: unknown): v is PluginSortMode {
  return typeof v === "string" && (SORT_MODES as readonly string[]).includes(v);
}

const DRAG_MODES: readonly DragMode[] = ["replace-all", "add", "replace-origin"];

function isDragMode(v: unknown): v is DragMode {
  return typeof v === "string" && (DRAG_MODES as readonly string[]).includes(v);
}

function isSettingsKey(v: string): v is keyof Settings {
  return v === "enabled" || v === "caseInsensitive" || v === "sortMode" || v === "dragMode" || v === "debug";
}

/** Deja las propiedades en el orden original: la que se modificó vuelve a su sitio en vez de ir al final. */
function restoreKeyOrder(fm: Record<string, unknown>, order: string[]) {
  const current = Object.keys(fm);
  const final = [...order.filter((k) => current.includes(k)), ...current.filter((k) => !order.includes(k))];
  if (final.every((k, i) => k === current[i])) return;
  const values = new Map(current.map((k) => [k, fm[k]] as const));
  for (const k of current) delete fm[k];
  for (const k of final) fm[k] = values.get(k);
}

function sameList(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isFn(v: unknown): boolean {
  return typeof v === "function";
}

function isListLike(v: unknown): v is ListLike {
  if (!isRecord(v)) return false;
  return typeof v.length === "function" && typeof v.get === "function";
}

function isNullValue(v: Value): boolean {
  return v instanceof NullValue || v === NullValue.value || v.constructor.name === "NullValue";
}

function valueText(v: Value | null): string {
  if (v == null) return "";
  try {
    return v.toString();
  } catch {
    return "";
  }
}

const adapter: ValueAdapter<Value> = {
  isList: (v) => isListLike(v),
  items: (v) => {
    if (!isListLike(v)) return [];
    const out: Value[] = [];
    const n = v.length();
    for (let i = 0; i < n; i++) out.push(v.get(i));
    return out;
  },
  isNull: (v) => isNullValue(v),
  text: (v) => valueText(v),
};

function hasGroupedDataAccessor(proto: unknown): proto is object {
  if (!isRecord(proto)) return false;
  const desc = Object.getOwnPropertyDescriptor(proto, "groupedData");
  return !!desc && typeof desc.get === "function";
}

interface AccessorLike {
  configurable?: boolean;
  enumerable?: boolean;
  get?: (this: unknown) => unknown;
}

function descriptorOf(proto: object): TypedDescriptor | undefined {
  const desc: AccessorLike | undefined = Object.getOwnPropertyDescriptor(proto, "groupedData");
  if (typeof desc?.get !== "function") return undefined;
  const get = desc.get;
  return {
    configurable: desc.configurable,
    enumerable: desc.enumerable,
    get(this: unknown): unknown {
      return Reflect.apply<unknown, [], unknown>(get, this, []);
    },
  };
}

function prototypeOf(value: object): object | null {
  const proto: unknown = Object.getPrototypeOf(value) as unknown;
  return isRecord(proto) ? proto : null;
}

function readProcess(host: object): ProcessFn | undefined {
  if (!("processFrontMatter" in host)) return undefined;
  const value = (host as { processFrontMatter?: unknown }).processFrontMatter;
  if (typeof value !== "function") return undefined;
  return value as ProcessFn;
}

function writeProcess(host: object, fn: ProcessFn | undefined): void {
  const rec = host as { processFrontMatter?: ProcessFn };
  if (fn) rec.processFrontMatter = fn;
  else delete rec.processFrontMatter;
}

function bind<T>(value: T): T {
  return value;
}

function callGetter(get: (this: unknown) => unknown, receiver: unknown): unknown {
  return Reflect.apply<unknown, [], unknown>(get, receiver, []);
}

function callProcess(
  fn: ProcessFn,
  thisArg: unknown,
  file: unknown,
  wrapped: (frontmatter: Frontmatter) => unknown,
  options?: unknown,
): unknown {
  return Reflect.apply<unknown, [unknown, (frontmatter: Frontmatter) => unknown, unknown?], unknown>(fn, thisArg, [
    file,
    wrapped,
    options,
  ]);
}

function readSettings(raw: unknown): Settings {
  const stored = isRecord(raw) ? raw : {};
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULTS.enabled,
    caseInsensitive: typeof stored.caseInsensitive === "boolean" ? stored.caseInsensitive : DEFAULTS.caseInsensitive,
    sortMode: isSortMode(stored.sortMode) ? stored.sortMode : DEFAULTS.sortMode,
    dragMode: isDragMode(stored.dragMode) ? stored.dragMode : DEFAULTS.dragMode,
    debug: typeof stored.debug === "boolean" ? stored.debug : DEFAULTS.debug,
  };
}

function entryPath(entry: BasesEntry): string {
  const file = entry.file;
  return file.path || file.name;
}

function describeValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return `${typeof v}:${String(v)}`;
  if (!isRecord(v)) return typeof v;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "?";
  return `${ctor}:${valueText(v as unknown as Value)}`;
}

function groupsSignature(groups: readonly BasesEntryGroup[]): string {
  const parts: string[] = [];
  for (const g of groups) {
    const paths = Array.isArray(g.entries) ? g.entries.map(entryPath).join("\u0001") : "";
    parts.push(`${describeValue(g.key)}\u0002${paths}`);
  }
  return parts.join("\u0003");
}

interface GroupSummary {
  key: string;
  list: boolean;
  entries: number;
}

interface BuildInfo {
  order: number | null;
  holder: string | null;
  unfiltered: number | null;
}

interface DiagEntry {
  at: string;
  note: string;
  resultId: number;
  dataCount: number;
  caller: string[];
  repeat: number;
  info: BuildInfo;
  raw: GroupSummary[];
  out: GroupSummary[] | null;
}

function summarize(groups: readonly BasesEntryGroup[]): GroupSummary[] {
  return groups.map((g) => ({
    key: describeValue(g.key),
    list: g.key !== undefined && isListLike(g.key),
    entries: Array.isArray(g.entries) ? g.entries.length : -1,
  }));
}

function callerLines(): string[] {
  const stack = new Error().stack;
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(3, 10)
    .map((line) => line.trim().replace(/\s+/g, " ").slice(0, 160));
}

interface ProbeEntry {
  at: string;
  target: string;
  op: string;
  resultId: number;
  repeat: number;
  value: string;
  stack: string[];
}

function stackLines(skip: number): string[] {
  const stack = new Error().stack;
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(skip, skip + 12)
    .map((line) => line.trim().replace(/\s+/g, " ").slice(0, 160));
}

function briefValue(v: unknown): string {
  if (!Array.isArray(v)) return typeof v;
  let text: string;
  try {
    text = JSON.stringify(v.slice(0, 2));
  } catch {
    text = "?";
  }
  return `array(${v.length}) ${text.slice(0, 80)}`;
}

function fileOfView(view: unknown): unknown {
  return isRecord(view) ? view.file : undefined;
}

export default class NativeSplitGroupsPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  private patchedProto: object | null = null;
  private originalDescriptor: TypedDescriptor | null = null;
  private patchedGetter: ((this: object) => unknown) | null = null;
  private version = 0;
  private nativeGetter: ((this: unknown) => unknown) | null = null;
  private cache = new WeakMap<object, { version: number; sig: string; result: BasesEntryGroup[]; info: BuildInfo }>();
  private holderPaths = new WeakMap<object, { path: string[] | null; at: number }>();
  private lastFingerprint = "";
  private internals = new Map<number, string[]>();
  private drag: DragState | null = null;
  private diagLog: DiagEntry[] = [];
  private resultIds = new WeakMap<object, number>();
  private nextResultId = 1;
  private probeLog: ProbeEntry[] = [];
  private dragLog: unknown[] = [];
  private optionsPatched = false;
  private optionsCache = new Map<string, Array<{ key: Value; label: string }>>();
  /** Orden de las propiedades de la nota antes de escribir. */
  private snapshotOrder: string[] = [];
  /** Notas cuyo arrastre no cambió nada. */
  private unchangedMoves = new Map<string, number>();
  private probed = new WeakSet<object>();
  private selfReads = 0;
  private matchDepth = 0;
  private unloaded = false;
  private methodPatches: PatchedMethod[] = [];
  private wrappers = new WeakMap<object, Map<string, BasesEntry>>();

  async onload() {
    this.settings = readSettings((await this.loadData()) as unknown);
    this.addSettingTab(new SplitSettingTab(this.app, this));

    this.patchProcessFrontMatter();
    this.patchViewOptions();
    const onStart = (ev: Event) => this.onDragStart(ev);
    const onEnd = () => {
      if (this.drag) this.drag.end = Date.now();
    };
    this.registerDomEvent(document, "dragstart", onStart, true);
    this.registerDomEvent(document, "pointerdown", onStart, true);
    this.registerDomEvent(document, "drop", onEnd, true);
    this.registerDomEvent(document, "dragend", onEnd, true);
    this.registerDomEvent(document, "pointerup", onEnd, true);

    this.addCommand({
      id: "toggle-split-groups",
      name: t("commandToggle"),
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        new Notice(this.settings.enabled ? t("noticeEnabled") : t("noticeDisabled"));
      },
    });

    this.addCommand({
      id: "copy-diagnostics",
      name: t("commandDiag"),
      callback: () => {
        void this.copyDiagnostics();
      },
    });

    this.patchListMatching();

    const attempt = () => {
      this.patchViewOptions();
      this.tryPatch();
      for (const delay of [300, 1000, 2500, 5000]) {
        window.setTimeout(() => {
          if (!this.unloaded) this.tryPatch();
        }, delay);
      }
    };
    this.app.workspace.onLayoutReady(attempt);
    const dropOptions = () => this.optionsCache.clear();
    this.registerEvent(this.app.metadataCache.on("changed", dropOptions));
    this.registerEvent(this.app.metadataCache.on("deleted", dropOptions));
    this.registerEvent(this.app.workspace.on("layout-change", attempt));
    this.registerEvent(this.app.workspace.on("active-leaf-change", attempt));
  }

  onunload() {
    this.unloaded = true;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    for (const p of this.methodPatches) {
      if (p.proto[p.name] === p.wrapper) p.proto[p.name] = p.original;
    }
    this.methodPatches = [];
    if (this.patchedProto && this.originalDescriptor) {
      Object.defineProperty(this.patchedProto, "groupedData", this.originalDescriptor);
    }
    this.patchedProto = null;
    this.refreshBases();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.version++;
    this.refreshBases();
  }

  // ---- Arrastre en Kanban ---------------------------------------------------

  private patchProcessFrontMatter() {
    const fm = this.app.fileManager;
    const original = readProcess(fm);
    if (!original) return;
    const hadOwn = Object.prototype.hasOwnProperty.call(fm, "processFrontMatter");

    const patched: ProcessFn = (file, fn, options) => {
      const wrapped = (frontmatter: Frontmatter) => {
        const lists = this.snapshotLists(frontmatter);
        const ret = fn(frontmatter);
        try {
          this.applyDragToFrontmatter(frontmatter, lists, isRecord(file) && typeof file.path === "string" ? file.path : "?");
        } catch (err) {
          console.error("[native-split-groups] error en el modo de arrastre; se deja la escritura original", err);
        }
        return ret;
      };
      return callProcess(original, fm, file, wrapped, options);
    };
    writeProcess(fm, patched);

    this.register(() => {
      if (readProcess(fm) !== patched) return;
      if (hadOwn) writeProcess(fm, original);
      else writeProcess(fm, undefined);
    });
  }

  private snapshotLists(frontmatter: Frontmatter): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    const mode = this.drag?.mode;
    if (!mode || !this.dragIsRecent()) return out;
    this.snapshotOrder = Object.keys(frontmatter);
    for (const key of Object.keys(frontmatter)) {
      const value = frontmatter[key];
      if (Array.isArray(value)) out[key] = value as unknown[];
    }
    return out;
  }

  private dragIsRecent(): boolean {
    const d = this.drag;
    if (!d) return false;
    const now = Date.now();
    return d.end >= d.start && now - d.end <= 3000 && now - d.start <= 60000;
  }

  private applyDragToFrontmatter(frontmatter: Frontmatter, lists: Record<string, unknown[]>, fileName: string) {
    const ci = this.settings.caseInsensitive;
    const mode = this.drag?.mode;
    if (!mode) return;
    for (const key of Object.keys(lists)) {
      const before = lists[key];
      const after = frontmatter[key];
      if (!before) continue;

      // Arrastre a la columna «None»
      if (after === undefined || !(key in frontmatter)) {
        const origin = this.drag ? matchOrigin(this.drag.levels, before, ci) : undefined;
        const res = applyDragToNone(mode, before, origin, ci);
        if (!res) continue;
        frontmatter[key] = res.blank ? null : res.value;
        restoreKeyOrder(frontmatter, this.snapshotOrder);
        if (!res.blank && sameList(before, res.value)) {
          this.unchangedMoves.set(fileName, Date.now());
          this.cancelPendingMove(fileName);
        }
        this.logDrag({ file: fileName, levels: this.drag?.levels, mode, key, before, nativeWrote: "(propiedad borrada)", origin, finalValue: res.blank ? null : res.value, fallback: res.fallback, viewFound: !!this.drag?.view, toNone: true, keysBefore: this.snapshotOrder, keysAfter: Object.keys(frontmatter) });
        if (res.fallback) new Notice(t("noticeSourceNotFound"));
        continue;
      }

      if (!isListToSingleValue(before, after, ci)) continue;

      const origin = this.drag ? matchOrigin(this.drag.levels, before, ci) : undefined;
      const res = applyDragMode(mode, before, after, origin, ci);
      if (!res) continue;

      frontmatter[key] = res.value;
      if (sameList(before, res.value)) {
        this.unchangedMoves.set(fileName, Date.now());
        this.cancelPendingMove(fileName);
      }
      this.logDrag({ file: fileName, levels: this.drag?.levels, mode, key, before, nativeWrote: after, origin, finalValue: res.value, fallback: res.fallback, viewFound: !!this.drag?.view });
      if (this.settings.debug) console.debug("[native-split-groups] drag on", key, { before, after, origin, result: res.value });
      if (res.fallback) {
        new Notice(t("noticeSourceNotFound"));
      }
    }
  }

  private cancelPendingMove(path: string) {
    for (const delay of [50, 250, 800]) {
      window.setTimeout(() => {
        if (this.unloaded) return;
        const views = this.kanbanViews();
        let cleared = 0;
        for (const view of views) {
          const pending = view.pendingMove;
          if (!isRecord(pending) || !isRecord(pending.entry)) continue;
          const file = pending.entry.file;
          if (!isRecord(file) || file.path !== path) continue;
          view.pendingMove = null;
          cleared++;
          if (isFn(view.display)) Reflect.apply(view.display as (...args: unknown[]) => unknown, view, []);
          else if (isFn(view.updateVirtualDisplay)) Reflect.apply(view.updateVirtualDisplay as (...args: unknown[]) => unknown, view, []);
        }
        this.logDrag({ file: path, cancelTry: delay, kanbanViews: views.length, cleared });
      }, delay);
    }
  }

  /** Todas las vistas Kanban abiertas en pestañas. */
  private kanbanViews(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== "bases") return;
      this.scanFor(leaf.view, (proto, obj) => {
        if (isRecord(proto) && isFn(proto.finishDisplay) && isFn(proto.renderColumns)) out.push(obj);
        return false;
      });
    });
    return out;
  }

  private logDrag(entry: Record<string, unknown>) {
    if (!this.settings.debug) return;
    this.dragLog.push({ at: new Date().toISOString(), ...entry });
    if (this.dragLog.length > 20) this.dragLog.shift();
  }

  private onDragStart(ev: Event) {
    const target = ev.target instanceof Element ? ev.target : null;
    const container = target?.closest(BASES_CONTAINER) ?? null;
    // Solo el Kanban reescribe la propiedad al arrastrar.
    if (!target || !container || !target.closest(".bases-kanban-container")) {
      this.drag = null;
      return;
    }
    const { mode, view } = this.modeForTarget(target);
    this.drag = { mode, view, start: Date.now(), end: 0, levels: this.captureLevels(target, container) };
  }

  // ---- Modo de arrastre por vista --------------------------------------------

  /** Añade la opción «arrastre de tarjetas» a los ajustes de las vistas Kanban de Obsidian. */
  private patchViewOptions() {
    if (this.optionsPatched || this.unloaded) return;
    const app: unknown = this.app;
    const internals = isRecord(app) ? app.internalPlugins : undefined;
    if (!isRecord(internals) || typeof internals.getEnabledPluginById !== "function") return;
    const bases: unknown = Reflect.apply(internals.getEnabledPluginById as (...args: unknown[]) => unknown, internals, ["bases"]);
    if (!isRecord(bases) || typeof bases.getRegistration !== "function") return;
    const entry: unknown = Reflect.apply(bases.getRegistration as (...args: unknown[]) => unknown, bases, ["kanban"]);
    if (!isRecord(entry) || typeof entry.options !== "function") return;
    const original = entry.options as (...args: unknown[]) => unknown;
    const wrapper = (...args: unknown[]): unknown => {
      const base: unknown = Reflect.apply(original, entry, args);
      const list: unknown[] = Array.isArray(base) ? (base as unknown[]) : [];
      return [...list, this.dragViewOption(), this.allOptionsOption()];
    };
    entry.options = wrapper;
    this.optionsPatched = true;
    this.register(() => {
      if (entry.options === wrapper) entry.options = original;
      this.optionsPatched = false;
    });
  }

  private allOptionsOption(): Record<string, unknown> {
    return {
      displayName: t("allOptionsName"),
      type: "toggle",
      key: VIEW_ALL_OPTIONS_KEY,
      default: false,
      shouldHide: (cfg: unknown) => !(isRecord(cfg) && Boolean(cfg.groupOrder)),
    };
  }

  private dragViewOption(): Record<string, unknown> {
    return {
      displayName: t("dragViewName"),
      type: "dropdown",
      key: VIEW_DRAG_KEY,
      options: {
        "": t("dragViewDefault"),
        "replace-all": t("dragReplaceAll"),
        add: t("dragAdd"),
        "replace-origin": t("dragReplaceOrigin"),
      },
    };
  }

  private modeForTarget(target: Element): { mode: DragMode; view: Record<string, unknown> | null } {
    const fallback = this.settings.dragMode;
    let config: unknown;
    let found: Record<string, unknown> | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (config !== undefined || leaf.view.getViewType() !== "bases") return;
      const host: unknown = leaf.view;
      const root = isRecord(host) ? host.containerEl : undefined;
      if (!(root instanceof HTMLElement) || !root.contains(target)) return;
      this.scanFor(leaf.view, (proto, obj) => {
        if (!isRecord(proto) || !isFn(proto.finishDisplay) || !isFn(proto.renderColumns)) return false;
        const el = obj.containerEl;
        if (!(el instanceof HTMLElement) || !el.contains(target)) return false;
        config = obj.config;
        found = obj;
        return true;
      });
    });
    if (!isRecord(config) || typeof config.get !== "function") return { mode: fallback, view: found };
    try {
      const value: unknown = Reflect.apply(config.get as (...args: unknown[]) => unknown, config, [VIEW_DRAG_KEY]);
      return { mode: isDragMode(value) ? value : fallback, view: found };
    } catch {
      return { mode: fallback, view: found };
    }
  }

  private captureLevels(target: Element, container: Element): string[][] {
    const card = target.closest('[draggable="true"], [class*="card"], [class*="item"]') ?? target;
    const cardsBox = card.parentElement;
    if (!cardsBox) return [];
    const ci = this.settings.caseInsensitive;
    const levels: string[][] = [];
    let node: Element | null = cardsBox.parentElement;
    let budget = 3000;
    for (let depth = 0; node && node !== container && depth < 4 && budget > 0; depth++) {
      const texts = new Set<string>();
      for (const el of Array.from(node.querySelectorAll("*"))) {
        if (--budget < 0) break;
        if (el.childElementCount > 0 || cardsBox.contains(el)) continue;
        const t = normalizeKey(el.textContent ?? "", ci);
        if (t && t.length <= 80) texts.add(t);
      }
      levels.push([...texts]);
      node = node.parentElement;
    }
    return levels;
  }

  private tryPatch() {
    const viewsPatched = this.tryPatchViews();
    if (this.patchedProto) {
      const current: AccessorLike | undefined = Object.getOwnPropertyDescriptor(this.patchedProto, "groupedData");
      if (current?.get === this.patchedGetter) {
        if (viewsPatched) this.refreshBasesLater();
        return;
      }
      this.patchedProto = null;
      this.patchedGetter = null;
      this.originalDescriptor = null;
    }
    const proto = this.findQueryResultProto();
    if (!proto) return;

    const desc = descriptorOf(proto);
    const previous = desc?.get;
    if (!desc || !previous) return;
    this.originalDescriptor = desc;
    this.patchedProto = proto;

    const plugin = bind(this);
    this.nativeGetter = previous;
    const get = function (this: object): unknown {
      const raw = plugin.withoutMatching(() => callGetter(previous, this));
      if (!Array.isArray(raw)) return raw;
      const groups = raw as BasesEntryGroup[];
      const noInfo: BuildInfo = { order: null, holder: null, unfiltered: null };
      if (!plugin.settings.enabled) {
        plugin.recordDiag(this, groups, null, "disabled", noInfo, "disabled");
        return raw;
      }
      const manual = plugin.manualOrderOf(this);
      const sig = `${groupsSignature(groups)}\u0004${manual ? manual.order.join("\u0005") : "-"}`;
      const hit = plugin.cache.get(this);
      if (hit && hit.version === plugin.version && hit.sig === sig) {
        plugin.recordDiag(this, groups, hit.result, "cache-hit", hit.info, sig);
        return hit.result;
      }
      try {
        const built = plugin.build(this, groups, manual);
        plugin.cache.set(this, { version: plugin.version, sig, result: built.groups, info: built.info });
        plugin.recordDiag(this, groups, built.groups, "split", built.info, sig);
        return built.groups;
      } catch (err) {
        console.error("[native-split-groups] Error al dividir grupos, se usan los grupos originales", err);
        plugin.recordDiag(this, groups, null, `error: ${err instanceof Error ? err.message : String(err)}`, noInfo, sig);
        return raw;
      }
    };
    this.patchedGetter = get;

    Object.defineProperty(proto, "groupedData", {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      get,
    });

    if (this.settings.debug) console.debug("[native-split-groups] patched BasesQueryResult.groupedData");
    this.refreshBasesLater();
  }

  private split(result: object, groups: BasesEntryGroup[]): BasesEntryGroup[] {
    const data = "data" in result ? result.data : undefined;
    const ordered = Array.isArray(data) ? (data as BasesEntry[]) : [];
    return splitGroups(groups, ordered, entryPath, adapter, this.splitOptions(result), (template, key, entries) => {
      const norm = this.keyNorm(key);
      return this.makeGroup(
        template,
        key,
        entries.map((e) => this.wrapEntry(e, norm)),
      );
    });
  }

  dropSettledMove(view: KanbanLike, args: unknown[]) {
    const pending = args[0];
    if (!isRecord(pending) || !isRecord(pending.entry)) return;
    const file = pending.entry.file;
    // Si el arrastre no cambió la nota, la tarjeta no se mueve.
    const path = isRecord(file) && typeof file.path === "string" ? file.path : undefined;
    const stamp = path ? this.unchangedMoves.get(path) : undefined;
    if (path && stamp !== undefined) {
      this.unchangedMoves.delete(path);
      if (Date.now() - stamp < 10000) {
        args[0] = null;
        return;
      }
    }
    const target = view.orderedGroups?.find((g) => this.keyNorm(g.key) === this.keyNorm(pending.targetKey as Value | undefined));
    if (target && Array.isArray(target.entries) && target.entries.some((e) => e.file === file)) args[0] = null;
  }

  private keyNorm(key: Value | undefined): string {
    return key === undefined || isNullValue(key) ? NO_VALUE : normalizeKey(valueText(key), this.settings.caseInsensitive);
  }

  private makeGroup(template: BasesEntryGroup, key: Value | undefined, entries: BasesEntry[]): BasesEntryGroup {
    const created = Object.create(prototypeOf(template)) as BasesEntryGroup;
    Object.assign(created, template, { key, entries });
    return created;
  }

  private wrapEntry(entry: BasesEntry, norm: string): BasesEntry {
    let per = this.wrappers.get(entry);
    if (!per) {
      per = new Map();
      this.wrappers.set(entry, per);
    }
    let wrapped = per.get(norm);
    if (!wrapped) {
      wrapped = Object.create(entry) as BasesEntry;
      per.set(norm, wrapped);
    }
    return wrapped;
  }

  private sortModeOf(result: object): "az" | "za" | "most" | "fewest" {
    if (this.settings.sortMode !== "native") return this.settings.sortMode;
    const config = "config" in result ? result.config : undefined;
    const groupBy = isRecord(config) ? config.groupBy : undefined;
    return isRecord(groupBy) && groupBy.direction === "DESC" ? "za" : "az";
  }

  private splitOptions(result: object) {
    return { caseInsensitive: this.settings.caseInsensitive, sortMode: this.sortModeOf(result) };
  }

  // ---- Vistas de Bases (controlador y kanban) --------------------------------

  private tryPatchViews(): boolean {
    let changed = false;
    const plugin = bind(this);

    const controller = this.findViewProto((proto) => isFn(proto.getAllGroups) && isFn(proto.notifyView));
    if (controller && !this.isPatched(controller, "notifyView")) {
      this.wrapMethod(controller, "notifyView", function (this: unknown, original, args) {
        plugin.matchDepth++;
        try {
          return Reflect.apply(original, this, args);
        } finally {
          plugin.matchDepth--;
        }
      });
      this.wrapMethod(controller, "getAllGroups", function (this: unknown, original, args) {
        if (plugin.settings.enabled) {
          try {
            const rows = plugin.menuRows(this as BasesController);
            if (rows) return rows;
          } catch (err) {
            console.error("[native-split-groups] Error en la lista del menú Group, se usa la de Obsidian", err);
          }
        }
        return Reflect.apply(original, this, args);
      });
      changed = true;
    }

    const kanban = this.findViewProto((proto) => isFn(proto.finishDisplay) && isFn(proto.renderColumns));
    if (kanban && !this.isPatched(kanban, "finishDisplay")) {
      this.wrapMethod(kanban, "finishDisplay", function (this: unknown, original, args) {
        if (plugin.settings.enabled) {
          try {
            const view = this as KanbanLike;
            const columns = plugin.kanbanColumns(view);
            if (columns) view.orderedGroups = columns;
            plugin.dropSettledMove(view, args);
          } catch (err) {
            console.error("[native-split-groups] Error en las columnas del kanban, se usan las de Obsidian", err);
          }
        }
        return Reflect.apply(original, this, args);
      });
      changed = true;
    }
    return changed;
  }

  private withoutMatching<T>(fn: () => T): T {
    const saved = this.matchDepth;
    this.matchDepth = 0;
    try {
      return fn();
    } finally {
      this.matchDepth = saved;
    }
  }

  private isPatched(proto: Record<string, unknown>, name: string): boolean {
    return this.methodPatches.some((p) => p.proto === proto && p.name === name && proto[name] === p.wrapper);
  }

  private wrapMethod(
    proto: Record<string, unknown>,
    name: string,
    impl: (this: unknown, original: (...a: unknown[]) => unknown, args: unknown[]) => unknown,
  ) {
    const original = proto[name] as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      return impl.call(this, original, args);
    };
    proto[name] = wrapper;
    this.methodPatches.push({ proto, name, original, wrapper });
  }

  private findViewProto(pred: (proto: Record<string, unknown>) => boolean): Record<string, unknown> | null {
    let found: Record<string, unknown> | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found || leaf.view.getViewType() !== "bases") return;
      const proto = this.scanFor(leaf.view, (p) => isRecord(p) && pred(p));
      if (proto && isRecord(proto)) found = proto;
    });
    return found;
  }

  private patchListMatching() {
    const proto = ListValue.prototype as unknown as Record<string, unknown>;
    if (!isFn(proto.looseEquals)) return;
    const plugin = bind(this);
    const original = proto.looseEquals as (this: unknown, other: unknown) => boolean;
    const wrapper = function (this: unknown, other: unknown): boolean {
      const result = Reflect.apply(original, this, [other]);
      if (result || plugin.matchDepth === 0 || !plugin.settings.enabled) return result;
      return plugin.listHolds(this, other);
    };
    proto.looseEquals = wrapper;
    this.methodPatches.push({ proto, name: "looseEquals", original, wrapper });
  }

  private listHolds(list: unknown, key: unknown): boolean {
    if (!isListLike(list) || !isRecord(key)) return false;
    return listHoldsKey(list as unknown as Value, key as unknown as Value, adapter, this.settings.caseInsensitive);
  }

  private groupValues(entries: Iterable<BasesEntry>, property: unknown): Value[] | null {
    if (typeof property !== "string") return null;
    const values: Value[] = [];
    let anyList = false;
    for (const entry of entries) {
      let value: Value | undefined;
      try {
        value = (entry as unknown as { getValue: (p: string) => Value | undefined }).getValue(property);
      } catch {
        value = undefined;
      }
      if (value === undefined) value = NullValue.value;
      if (adapter.isList(value)) anyList = true;
      values.push(value);
    }
    return anyList ? values : null;
  }

  private keyFor(label: string | null): Value {
    return label === null ? NullValue.value : new StringValue(label);
  }

  private menuRows(ctl: BasesController): Array<{ key: Value; count: number; isVisible: boolean }> | null {
    const config = ctl.query?.getViewConfig?.(ctl.viewName);
    if (!isRecord(config) || !isRecord(config.groupBy) || !Array.isArray(config.groupOrder)) return null;
    const order = parseGroupOrder(config.groupOrder, this.settings.caseInsensitive);
    const entries = ctl.results?.values?.();
    if (!order || !entries) return null;
    const values = this.groupValues(entries, config.groupBy.property);
    if (!values) return null;
    const config2 = config as { get?: unknown };
    let showAll = false;
    try {
      if (typeof config2.get === "function") showAll = Reflect.apply(config2.get as (...args: unknown[]) => unknown, config, [VIEW_ALL_OPTIONS_KEY]) === true;
    } catch {
      showAll = false;
    }
    const extras = showAll ? this.vaultOptions(config.groupBy.property) : [];
    return menuGroups(values, order, adapter, this.settings.caseInsensitive, extras, showAll).map((row) => ({
      key: row.key ?? this.keyFor(row.label),
      count: row.count,
      isVisible: row.isVisible,
    }));
  }

  /**
   * Valores distintos que usa la propiedad en todo el vault.
   */
  private vaultOptions(property: unknown): Array<{ key: Value; label: string }> {
    if (typeof property !== "string") return [];
    const name = property.startsWith("note.") ? property.slice(5) : property;
    if (name.startsWith("file.") || name.startsWith("formula.")) return [];
    const cached = this.optionsCache.get(name);
    if (cached) return cached;
    const ci = this.settings.caseInsensitive;
    const wanted = name.toLowerCase();
    const found = new Map<string, string>();
    const add = (raw: unknown) => {
      if (typeof raw !== "string" && typeof raw !== "number") return;
      const label = String(raw).trim();
      const norm = normalizeKey(label, ci);
      if (norm !== "" && !found.has(norm)) found.set(norm, label);
    };
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      for (const key of Object.keys(fm)) {
        if (key.toLowerCase() !== wanted) continue;
        const value: unknown = fm[key];
        if (Array.isArray(value)) value.forEach(add);
        else add(value);
      }
    }
    const out = [...found.values()].map((label) => ({ key: this.keyFor(label), label }));
    this.optionsCache.set(name, out);
    return out;
  }

  private kanbanColumns(view: KanbanLike): BasesEntryGroup[] | null {
    const config = view.config;
    const data = view.data;
    if (!isRecord(config) || !isRecord(config.groupBy) || !Array.isArray(config.groupOrder)) return null;
    if (!data || !Array.isArray(data.data) || !Array.isArray(data.groupedData)) return null;
    if (!this.groupValues(data.data as BasesEntry[], config.groupBy.property)) return null;
    const order = parseGroupOrder(config.groupOrder, this.settings.caseInsensitive);
    if (!order) return null;
    const groups = data.groupedData as BasesEntryGroup[];
    const template = groups[0] ?? view.orderedGroups?.[0];
    return withEmptyColumns<Value, BasesEntry, BasesEntryGroup>(
      groups,
      order,
      adapter,
      this.settings.caseInsensitive,
      (label) => (template ? this.makeGroup(template, this.keyFor(label), []) : null),
    );
  }

  // ---- Diagnóstico ----------------------------------------------------------

  private recordDiag(
    result: object,
    raw: BasesEntryGroup[],
    out: BasesEntryGroup[] | null,
    note: string,
    info: BuildInfo,
    sig: string,
  ) {
    if (!this.settings.debug) return;
    let id = this.resultIds.get(result);
    if (id === undefined) {
      id = this.nextResultId++;
      this.resultIds.set(result, id);
      this.internals.set(id, describeShape(result));
    }
    const caller = callerLines();
    const fingerprint = `${note}|${id}|${caller.slice(0, 3).join("|")}|${sig}`;
    const last = this.diagLog[this.diagLog.length - 1];
    if (last && fingerprint === this.lastFingerprint) {
      last.repeat++;
      last.at = new Date().toISOString();
      return;
    }
    this.lastFingerprint = fingerprint;
    const data = "data" in result ? result.data : undefined;
    this.diagLog.push({
      at: new Date().toISOString(),
      note,
      resultId: id,
      dataCount: Array.isArray(data) ? data.length : -1,
      caller,
      repeat: 1,
      info,
      raw: summarize(raw),
      out: out ? summarize(out) : null,
    });
    if (this.diagLog.length > 40) this.diagLog.shift();
  }

  // ---- Orden manual (groupOrder) ---------------------------------------------

  private manualOrderOf(result: object): { path: string[]; order: string[] } | null {
    const now = Date.now();
    const cached = this.holderPaths.get(result);
    let path: string[] | null;
    if (cached && (cached.path !== null || now - cached.at < 2000)) {
      path = cached.path;
    } else {
      path = findGroupOrderPath(result);
      this.holderPaths.set(result, { path, at: now });
    }
    if (!path) return null;
    this.installProbes(result, path);
    this.selfReads++;
    let rawOrder: unknown;
    try {
      rawOrder = readGroupOrder(result, path);
    } finally {
      this.selfReads--;
    }
    const parsed = parseGroupOrder(rawOrder, this.settings.caseInsensitive);
    if (!parsed) {
      this.holderPaths.delete(result);
      return null;
    }
    return { path, order: parsed.map((e) => e.key) };
  }

  private installProbes(result: object, path: string[]) {
    if (!this.settings.debug || this.probed.has(result)) return;
    this.probed.add(result);
    let id = this.resultIds.get(result);
    if (id === undefined) {
      id = this.nextResultId++;
      this.resultIds.set(result, id);
      this.internals.set(id, describeShape(result));
    }
    const holder = holderAt(result, path);
    const targets: Array<[object | null, string, string]> = [
      [holder, "groupOrder", `${path.join(".") || "(root)"}.groupOrder`],
      [result, "groupedDataCache", "result.groupedDataCache"],
    ];
    for (const [obj, key, label] of targets) {
      if (!obj) continue;
      installProbe(obj, key, (op, value) => {
        if (!this.settings.debug || this.selfReads > 0) return;
        const stack = stackLines(3);
        const fp = `${label}|${op}|${stack.slice(0, 6).join("|")}`;
        const last = this.probeLog[this.probeLog.length - 1] as (ProbeEntry & { fp?: string }) | undefined;
        if (last && last.fp === fp) {
          last.repeat++;
          return;
        }
        const entry: ProbeEntry & { fp?: string } = {
          at: new Date().toISOString(),
          target: label,
          op,
          resultId: id,
          repeat: 1,
          value: briefValue(value),
          stack,
          fp,
        };
        this.probeLog.push(entry);
        if (this.probeLog.length > 60) this.probeLog.shift();
      });
    }
    if (holder) this.internals.set(1000 + id, ["[holder shape of result " + String(id) + "]", ...describeShape(holder, 1, 40)]);
  }

  private callWithoutGroupOrder(result: object, path: string[]): BasesEntryGroup[] | null {
    const native = this.nativeGetter;
    if (!native) return null;
    try {
      const out = this.withoutMatching(() => callGetter(native, hideGroupOrder(result, path)));
      return Array.isArray(out) ? (out as BasesEntryGroup[]) : null;
    } catch {
      return null;
    }
  }

  private build(
    result: object,
    groups: BasesEntryGroup[],
    manual: { path: string[]; order: string[] } | null,
  ): { groups: BasesEntryGroup[]; info: BuildInfo } {
    if (!manual) {
      return { groups: this.split(result, groups), info: { order: null, holder: null, unfiltered: null } };
    }
    const unfiltered = this.callWithoutGroupOrder(result, manual.path);
    const info: BuildInfo = {
      order: manual.order.length,
      holder: manual.path.join(".") || "(root)",
      unfiltered: unfiltered ? unfiltered.length : null,
    };
    const base = unfiltered ?? groups;
    if (!base.some((g) => g.key !== undefined && isListLike(g.key))) return { groups, info };
    const split = this.split(result, base);
    return {
      groups: applyGroupOrder<Value, BasesEntry, BasesEntryGroup>(
        split,
        manual.order,
        adapter,
        this.settings.caseInsensitive,
      ),
      info,
    };
  }

  private async buildReport(): Promise<string> {
    const lines: string[] = [];
    lines.push(`build: none-drag-4`);
    lines.push(`native-split-groups ${this.manifest.version} · Obsidian API ${apiVersion} · language ${getLanguage()}`);
    lines.push(`settings: ${JSON.stringify(this.settings)}`);
    lines.push(`getter still patched: ${this.patchedProto !== null}`);
    if (!this.settings.debug) lines.push("NOTE: Diagnostics is off, so the call log below is empty.");
    const seen = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("bases")) {
      const file = fileOfView(leaf.view);
      if (!(file instanceof TFile) || seen.has(file.path)) continue;
      seen.add(file.path);
      lines.push(`--- ${file.name} ---`);
      lines.push(await this.app.vault.cachedRead(file));
    }
    lines.push("--- result internals (by resultId) ---");
    lines.push(JSON.stringify(Object.fromEntries(this.internals), null, 1));
    lines.push("--- reads/writes of groupOrder and groupedDataCache (oldest first) ---");
    lines.push(JSON.stringify(this.probeLog.map(({ ...e }) => ({ ...e, fp: undefined })), null, 1));
    lines.push("--- Kanban drag writes (oldest first) ---");
    lines.push(JSON.stringify(this.dragLog, null, 1));
    lines.push("--- groupedData calls (oldest first; repeat = identical consecutive calls) ---");
    lines.push(JSON.stringify(this.diagLog, null, 1));
    return lines.join("\n");
  }

  private async copyDiagnostics() {
    const report = await this.buildReport();
    try {
      await navigator.clipboard.writeText(report);
      new Notice(t("noticeDiagCopied"));
    } catch {
      new Notice(t("noticeDiagFailed"));
    }
  }

  private findQueryResultProto(): object | null {
    if (hasGroupedDataAccessor(BasesQueryResult.prototype)) return BasesQueryResult.prototype;

    let found: object | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      found = this.scanFor(leaf.view, (proto, obj) => hasGroupedDataAccessor(proto) && "data" in obj);
    });
    return found;
  }

  private scanFor(root: unknown, matches: (proto: object, obj: Record<string, unknown>) => boolean): object | null {
    const seen = new Set<unknown>();
    const skip = new Set(["app", "leaf", "containerEl", "contentEl", "parent", "parentEl", "scope", "workspace"]);
    const queue: Array<[unknown, number]> = [[root, 0]];
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const [obj, depth] = next;
      if (!isRecord(obj) || seen.has(obj)) continue;
      seen.add(obj);
      if (typeof Node !== "undefined" && obj instanceof Node) continue;
      const proto = prototypeOf(obj);
      if (proto && matches(proto, obj)) return proto;
      if (depth >= 4) continue;
      for (const key of Object.keys(obj)) {
        if (skip.has(key)) continue;
        let val: unknown;
        try {
          val = obj[key];
        } catch {
          continue;
        }
        if (isRecord(val)) queue.push([val, depth + 1]);
      }
    }
    return null;
  }

  private refreshTimer: number | null = null;


  /**
   * Redibuja las bases abiertas.
   */
  refreshBasesLater(done: WeakSet<object> = new WeakSet(), attempt = 0) {
    if (this.unloaded) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.unloaded) return;
      if (this.refreshBases(done) && attempt < 4) this.refreshBasesLater(done, attempt + 1);
    }, attempt === 0 ? 600 : 500);
  }

  /** Devuelve true si alguna base todavía se está abriendo (queda pendiente para reintentar). */
  refreshBases(done: WeakSet<object> = new WeakSet()): boolean {
    let pending = false;
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.view.getViewType() !== "bases") return;
      // Las pestañas sin cargar se dibujan ya parcheadas cuando se abren.
      if ((leaf as { isDeferred?: boolean }).isDeferred) return;
      if (done.has(leaf)) return;
      const view: unknown = leaf.view;
      const container: unknown = isRecord(view) ? view.containerEl : undefined;
      const loaded = fileOfView(view) instanceof TFile && container instanceof HTMLElement && container.isConnected;
      if (!loaded) {
        pending = true;
        return;
      }
      done.add(leaf);
      // Solo hace falta redibujar lo que muestra grupos.
      if (!container.querySelector(GROUPED_SELECTOR)) return;
      const rebuild = leaf as LeafRebuild;
      if (typeof rebuild.rebuildView === "function") {
        void rebuild.rebuildView();
      } else if (leaf.getViewState().type === "bases") {
        void leaf.setViewState(leaf.getViewState());
      }
    });
    return pending;
  }
}

const GROUPED_SELECTOR =
  ".bases-kanban-container, .bases-cards-group, .bases-list-group, .bases-group-heading, .bases-group-row";

class SplitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NativeSplitGroupsPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t("enabledName"),
        desc: t("enabledDesc"),
        control: { type: "toggle", key: "enabled", defaultValue: true },
      },
      {
        name: t("caseName"),
        desc: t("caseDesc"),
        control: { type: "toggle", key: "caseInsensitive", defaultValue: true },
      },
      {
        name: t("sortName"),
        desc: t("sortDesc"),
        control: {
          type: "dropdown",
          key: "sortMode",
          defaultValue: "native",
          options: {
            native: t("sortNative"),
            most: t("sortMost"),
            fewest: t("sortFewest"),
          },
        },
      },
      {
        type: "group",
        heading: t("dragHeading"),
        items: [
          {
            name: t("dragName"),
            desc: t("dragDesc"),
            control: {
              type: "dropdown",
              key: "dragMode",
              defaultValue: "replace-all",
              options: {
                "replace-all": t("dragReplaceAll"),
                add: t("dragAdd"),
                "replace-origin": t("dragReplaceOrigin"),
              },
            },
          },
        ],
      },
      {
        name: t("debugName"),
        desc: t("debugDesc"),
        control: { type: "toggle", key: "debug", defaultValue: false },
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (!isSettingsKey(key)) return undefined;
    return this.plugin.settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if ((key === "enabled" || key === "caseInsensitive" || key === "debug") && typeof value === "boolean") {
      settings[key] = value;
    } else if (key === "sortMode" && isSortMode(value)) {
      settings.sortMode = value;
    } else if (key === "dragMode" && isDragMode(value)) {
      settings.dragMode = value;
    } else {
      return;
    }
    await this.plugin.saveSettings();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("enabledName"))
.setDesc(t("enabledDesc"))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("caseName"))
.setDesc(t("caseDesc"))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.caseInsensitive).onChange(async (v) => {
          this.plugin.settings.caseInsensitive = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t("sortName"))
      .setDesc(t("sortDesc"))
      .addDropdown((d) =>
        d
          .addOptions({ native: t("sortNative"), most: t("sortMost"), fewest: t("sortFewest") })
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (v) => {
            if (!isSortMode(v)) return;
            this.plugin.settings.sortMode = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName(t("dragHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("dragName"))
      .setDesc(t("dragDesc"))
      .addDropdown((d) =>
        d
          .addOptions({
            "replace-all": t("dragReplaceAll"),
            add: t("dragAdd"),
            "replace-origin": t("dragReplaceOrigin"),
          })
          .setValue(this.plugin.settings.dragMode)
          .onChange(async (v) => {
            if (!isDragMode(v)) return;
            this.plugin.settings.dragMode = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("debugName"))
      .setDesc(t("debugDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}