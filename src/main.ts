import {
  App,
  BasesEntry,
  BasesEntryGroup,
  BasesQueryResult,
  Notice,
  NullValue,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  Value,
  WorkspaceLeaf,
} from "obsidian";
import { GroupSortMode, ValueAdapter, normalizeKey, splitGroups } from "./split";
import { DragMode, applyDragMode, isListToSingleValue, matchOrigin } from "./drag";

interface Settings {
  enabled: boolean;
  caseInsensitive: boolean;
  sortMode: GroupSortMode;
  dragMode: DragMode;
}

const DEFAULTS: Settings = {
  enabled: true,
  caseInsensitive: true,
  sortMode: "native",
  dragMode: "replace-all",
};

const BASES_CONTAINER = '.bases-view, .bases-embed, .workspace-leaf-content[data-type="bases"]';

interface DragState {
  start: number;
  end: number;
  /** Textos de cabecera (normalizados) alrededor de la tarjeta, del nivel más cercano al más lejano. */
  levels: string[][];
}

interface ListLike {
  length: () => number;
  get: (index: number) => Value;
}

/** Getter leído de un prototipo, sin el `any` de `PropertyDescriptor`. */
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

interface LeafRebuild {
  rebuildView?: () => unknown;
}

const SORT_MODES: readonly GroupSortMode[] = ["native", "az", "za", "most", "fewest"];
const DRAG_MODES: readonly DragMode[] = ["replace-all", "add", "replace-origin"];

function isSortMode(v: unknown): v is GroupSortMode {
  return typeof v === "string" && (SORT_MODES as readonly string[]).includes(v);
}

function isDragMode(v: unknown): v is DragMode {
  return typeof v === "string" && (DRAG_MODES as readonly string[]).includes(v);
}

function isSettingsKey(v: string): v is keyof Settings {
  return v === "enabled" || v === "caseInsensitive" || v === "sortMode" || v === "dragMode";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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

function descriptorOf(proto: object): TypedDescriptor | undefined {
  const desc = Object.getOwnPropertyDescriptor(proto, "groupedData");
  if (typeof desc?.get !== "function") return undefined;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hay que conservar el getter original antes de reemplazarlo
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
  };
}

function entryPath(entry: BasesEntry): string {
  const file = entry.file;
  return file.path || file.name;
}

export default class NativeSplitGroupsPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  private patchedProto: object | null = null;
  private originalDescriptor: TypedDescriptor | null = null;
  private version = 0;
  private cache = new WeakMap<object, { version: number; result: BasesEntryGroup[] }>();
  private drag: DragState | null = null;

  async onload() {
    this.settings = readSettings((await this.loadData()) as unknown);
    this.addSettingTab(new SplitSettingTab(this.app, this));

    this.patchProcessFrontMatter();
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
      name: "Activar/desactivar la división de grupos en bases",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        new Notice(this.settings.enabled ? "División de grupos activada" : "División de grupos desactivada");
      },
    });

    const attempt = () => this.tryPatch();
    this.app.workspace.onLayoutReady(attempt);
    this.registerEvent(this.app.workspace.on("layout-change", attempt));
    this.registerEvent(this.app.workspace.on("active-leaf-change", attempt));
  }

  onunload() {
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
          this.applyDragToFrontmatter(frontmatter, lists);
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
    if (this.settings.dragMode === "replace-all" || !this.dragIsRecent()) return out;
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

  private applyDragToFrontmatter(frontmatter: Frontmatter, lists: Record<string, unknown[]>) {
    const ci = this.settings.caseInsensitive;
    for (const key of Object.keys(lists)) {
      const before = lists[key];
      const after = frontmatter[key];
      if (!before || !isListToSingleValue(before, after, ci)) continue;

      const origin = this.drag ? matchOrigin(this.drag.levels, before, ci) : undefined;
      const res = applyDragMode(this.settings.dragMode, before, after, origin, ci);
      if (!res) continue;

      frontmatter[key] = res.value;
      console.debug("[native-split-groups] arrastre en", key, { before, after, origin, result: res.value });
      if (res.fallback) {
        new Notice(
          "Native split groups: no se encontró la columna de origen. Se agregó el valor nuevo sin quitar ninguno.",
        );
      }
    }
  }

  private onDragStart(ev: Event) {
    if (this.settings.dragMode === "replace-all") return;
    const target = ev.target instanceof Element ? ev.target : null;
    const container = target?.closest(BASES_CONTAINER) ?? null;
    if (!target || !container) {
      this.drag = null;
      return;
    }
    this.drag = { start: Date.now(), end: 0, levels: this.captureLevels(target, container) };
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
    if (this.patchedProto) return;
    const proto = this.findQueryResultProto();
    if (!proto) return;

    const desc = descriptorOf(proto);
    const previous = desc?.get;
    if (!desc || !previous) return;
    this.originalDescriptor = desc;
    this.patchedProto = proto;

    const plugin = bind(this);
    const get = function (this: object): unknown {
      const raw = callGetter(previous, this);
      if (!plugin.settings.enabled || !Array.isArray(raw)) return raw;
      const groups = raw as BasesEntryGroup[];
      const hit = plugin.cache.get(this);
      if (hit && hit.version === plugin.version) return hit.result;
      try {
        const result = plugin.split(this, groups);
        plugin.cache.set(this, { version: plugin.version, result });
        return result;
      } catch (err) {
        console.error("[native-split-groups] Error al dividir grupos, se usan los grupos originales", err);
        return raw;
      }
    };

    Object.defineProperty(proto, "groupedData", {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      get,
    });

    console.debug("[native-split-groups] Parche aplicado a BasesQueryResult.groupedData");
    this.refreshBases();
  }

  private split(result: object, groups: BasesEntryGroup[]): BasesEntryGroup[] {
    const data = "data" in result ? result.data : undefined;
    const ordered = Array.isArray(data) ? (data as BasesEntry[]) : [];
    return splitGroups(groups, ordered, entryPath, adapter, this.splitOptions(), (template, key, entries) => {
      const created = Object.create(prototypeOf(template)) as BasesEntryGroup;
      Object.assign(created, template, { key, entries });
      return created;
    });
  }

  private splitOptions() {
    return { caseInsensitive: this.settings.caseInsensitive, sortMode: this.settings.sortMode };
  }

  private findQueryResultProto(): object | null {
    if (hasGroupedDataAccessor(BasesQueryResult.prototype)) return BasesQueryResult.prototype;

    let found: object | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      found = this.scanForQueryResult(leaf.view);
    });
    return found;
  }

  private scanForQueryResult(root: unknown): object | null {
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
      if (proto && hasGroupedDataAccessor(proto) && "data" in obj) return proto;
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

  /** Obliga a las bases abiertas a volver a leer groupedData. */
  refreshBases() {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.view.getViewType() !== "bases") return;
      const rebuild = leaf as LeafRebuild;
      if (typeof rebuild.rebuildView === "function") {
        void rebuild.rebuildView();
      } else {
        void leaf.setViewState(leaf.getViewState());
      }
    });
  }
}

class SplitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NativeSplitGroupsPlugin) {
    super(app, plugin);
  }

  /** Búsqueda de ajustes en Obsidian 1.13+. En versiones anteriores se usa display(). */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Dividir grupos en opciones únicas de lista",
        desc: "Cuando una base agrupa por una propiedad de lista, cada nota aparece en un grupo correspondiente a cada valor de la lista.",
        control: { type: "toggle", key: "enabled", defaultValue: true },
      },
      {
        name: "Unificación completa",
        desc: "«main» y «main» forman un solo grupo; se unifican [[main]], [[carpeta/main.md]] y [[main|alias]]; y se ignora el # de las etiquetas.",
        control: { type: "toggle", key: "caseInsensitive", defaultValue: true },
      },
      {
        name: "Orden de los grupos",
        desc: "«orden de bases» respeta el orden de agrupación nativo. Las notas dentro de cada grupo siempre mantienen el orden de la base.",
        control: {
          type: "dropdown",
          key: "sortMode",
          defaultValue: "native",
          options: {
            native: "Orden de Bases",
            az: "A → Z",
            za: "Z → A",
            most: "Más notas primero",
            fewest: "Menos notas primero",
          },
        },
      },
      {
        type: "group",
        heading: "Arrastre en kanban",
        items: [
          {
            name: "Qué hacer con la lista al mover una tarjeta de columna",
            desc: "Si no se puede saber de qué columna salió la tarjeta, la opción 3 se comporta como la 2.",
            control: {
              type: "dropdown",
              key: "dragMode",
              defaultValue: "replace-all",
              options: {
                "replace-all": "1. Sustituir todo por la columna nueva",
                add: "2. Agregar la columna nueva a las anteriores",
                "replace-origin": "3. Reemplazar columna de origen por columna nueva",
              },
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (!isSettingsKey(key)) return undefined;
    return this.plugin.settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if ((key === "enabled" || key === "caseInsensitive") && typeof value === "boolean") {
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
      .setName("Dividir grupos en opciones únicas de lista")
      .setDesc(
        "Cuando una base agrupa por una propiedad de lista, cada nota aparece en un grupo correspondiente a cada valor de la lista.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Unificación completa")
      .setDesc(
        "«main» y «main» forman un solo grupo; se unifican [[main]], [[carpeta/main.md]] y [[main|alias]]; y se ignora el # de las etiquetas.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.caseInsensitive).onChange(async (v) => {
          this.plugin.settings.caseInsensitive = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Orden de los grupos")
      .setDesc(
        "«orden de bases» respeta el orden de agrupación nativo. Las notas dentro de cada grupo siempre mantienen el orden de la base.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            native: "Orden de Bases",
            az: "A → Z",
            za: "Z → A",
            most: "Más notas primero",
            fewest: "Menos notas primero",
          })
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (v) => {
            if (!isSortMode(v)) return;
            this.plugin.settings.sortMode = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Arrastre en kanban").setHeading();

    new Setting(containerEl)
      .setName("Qué hacer con la lista al mover una tarjeta de columna")
      .setDesc("Si no se puede saber de qué columna salió la tarjeta, la opción 3 se comporta como la 2.")
      .addDropdown((d) =>
        d
          .addOptions({
            "replace-all": "1. Sustituir todo por la columna nueva",
            add: "2. Agregar la columna nueva a las anteriores",
            "replace-origin": "3. Reemplazar columna de origen por columna nueva",
          })
          .setValue(this.plugin.settings.dragMode)
          .onChange(async (v) => {
            if (!isDragMode(v)) return;
            this.plugin.settings.dragMode = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}