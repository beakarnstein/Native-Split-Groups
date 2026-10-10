import * as obsidian from "obsidian";
import { Plugin, PluginSettingTab, Setting, App, WorkspaceLeaf } from "obsidian";
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

type AnyObj = Record<string, any>;

const adapter: ValueAdapter<any> = {
  isList: (v) => !!v && typeof v.length === "function" && typeof v.get === "function",
  items: (v) => {
    const out: any[] = [];
    const n = v.length();
    for (let i = 0; i < n; i++) out.push(v.get(i));
    return out;
  },
  isNull: (v) => {
    if (v == null) return true;
    const NullValue = (obsidian as AnyObj).NullValue;
    if (NullValue && (v === NullValue.value || v instanceof NullValue)) return true;
    return v.constructor?.name === "NullValue";
  },
  text: (v) => {
    try {
      return String(v?.toString?.() ?? "");
    } catch {
      return "";
    }
  },
};

function hasGroupedDataAccessor(proto: unknown): proto is object {
  if (!proto || typeof proto !== "object") return false;
  const d = Object.getOwnPropertyDescriptor(proto, "groupedData");
  return !!d && typeof d.get === "function";
}

export default class NativeSplitGroupsPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  private patchedProto: object | null = null;
  private originalDescriptor: PropertyDescriptor | null = null;
  private version = 0;
  private cache = new WeakMap<object, { version: number; result: any[] }>();
  private drag: DragState | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
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
      name: "Activar/desactivar la división de grupos en Bases",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        new obsidian.Notice(
          this.settings.enabled ? "División de grupos activada" : "División de grupos desactivada",
        );
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
    const fm = this.app.fileManager as unknown as AnyObj;
    const original = fm.processFrontMatter;
    if (typeof original !== "function") return;
    const hadOwn = Object.prototype.hasOwnProperty.call(fm, "processFrontMatter");
    const plugin = this;

    const patched = function (this: unknown, file: unknown, fn: (f: AnyObj) => void, options?: unknown) {
      const wrapped = (frontmatter: AnyObj) => {
        const lists = plugin.snapshotLists(frontmatter);
        const ret = fn(frontmatter);
        try {
          plugin.applyDragToFrontmatter(frontmatter, lists);
        } catch (err) {
          console.error("[native-split-groups] error en el modo de arrastre; se deja la escritura original", err);
        }
        return ret;
      };
      return original.call(this, file, wrapped, options);
    };
    fm.processFrontMatter = patched;

    this.register(() => {
      if (fm.processFrontMatter !== patched) return; 
      if (hadOwn) fm.processFrontMatter = original;
      else delete fm.processFrontMatter;
    });
  }

  private snapshotLists(frontmatter: AnyObj): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    if (this.settings.dragMode === "replace-all" || !this.dragIsRecent()) return out;
    for (const key of Object.keys(frontmatter)) {
      if (Array.isArray(frontmatter[key])) out[key] = [...frontmatter[key]];
    }
    return out;
  }

  private dragIsRecent(): boolean {
    const d = this.drag;
    if (!d) return false;
    const now = Date.now();
    return d.end >= d.start && now - d.end <= 3000 && now - d.start <= 60000;
  }

  private applyDragToFrontmatter(frontmatter: AnyObj, lists: Record<string, unknown[]>) {
    const ci = this.settings.caseInsensitive;
    for (const key of Object.keys(lists)) {
      const before = lists[key];
      const after = frontmatter[key];
      if (!isListToSingleValue(before, after, ci)) continue;

      const origin = this.drag ? matchOrigin(this.drag.levels, before, ci) : undefined;
      const res = applyDragMode(this.settings.dragMode, before, after, origin, ci);
      if (!res) continue;

      frontmatter[key] = res.value;
      console.debug("[native-split-groups] arrastre en", key, { before, after, origin, result: res.value });
      if (res.fallback) {
        new obsidian.Notice(
          "Native Split Groups: no se encontró la columna de origen. Se agregó el valor nuevo sin quitar ninguno.",
        );
      }
    }
  }

  private onDragStart(ev: Event) {
    if (this.settings.dragMode === "replace-all") return;
    const target = ev.target as Element | null;
    const container = target?.closest?.(BASES_CONTAINER);
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

    const desc = Object.getOwnPropertyDescriptor(proto, "groupedData")!;
    const original = desc.get!;
    const self = this;
    this.originalDescriptor = desc;
    this.patchedProto = proto;

    Object.defineProperty(proto, "groupedData", {
      ...desc,
      get(this: AnyObj) {
        const groups = original.call(this);
        if (!self.settings.enabled || !Array.isArray(groups)) return groups;
        const hit = self.cache.get(this);
        if (hit && hit.version === self.version) return hit.result;
        try {
          const result = self.split(this, groups);
          self.cache.set(this, { version: self.version, result });
          return result;
        } catch (err) {
          console.error("[native-split-groups] Error al dividir grupos, se usan los grupos originales", err);
          return groups;
        }
      },
    });

    console.debug("[native-split-groups] Parche aplicado a BasesQueryResult.groupedData");
    this.refreshBases();
  }

  private split(result: AnyObj, groups: any[]): any[] {
    const ordered: any[] = Array.isArray(result.data) ? result.data : [];
    return splitGroups(
      groups,
      ordered,
      (e: AnyObj) => e?.file?.path ?? String(e?.file?.name ?? ""),
      adapter,
      { caseInsensitive: this.settings.caseInsensitive, sortMode: this.settings.sortMode },
      (template, key, entries) => {
        const g = Object.create(Object.getPrototypeOf(template));
        Object.assign(g, template, { key, entries });
        return g;
      },
    );
  }

  private findQueryResultProto(): object | null {
    const exported = (obsidian as AnyObj).BasesQueryResult;
    if (exported?.prototype && hasGroupedDataAccessor(exported.prototype)) return exported.prototype;

    let found: object | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      found = this.scanForQueryResult(leaf.view as unknown as AnyObj);
    });
    return found;
  }

  private scanForQueryResult(root: AnyObj): object | null {
    const seen = new Set<unknown>();
    const skip = new Set(["app", "leaf", "containerEl", "contentEl", "parent", "parentEl", "scope", "workspace"]);
    const queue: Array<[AnyObj, number]> = [[root, 0]];
    while (queue.length) {
      const [obj, depth] = queue.shift()!;
      if (!obj || seen.has(obj)) continue;
      seen.add(obj);
      if (typeof Node !== "undefined" && obj instanceof Node) continue;
      const proto = Object.getPrototypeOf(obj);
      if (hasGroupedDataAccessor(proto) && "data" in obj) return proto;
      if (depth >= 4) continue;
      for (const key of Object.keys(obj)) {
        if (skip.has(key)) continue;
        let val: unknown;
        try {
          val = obj[key];
        } catch {
          continue;
        }
        if (val && typeof val === "object") queue.push([val as AnyObj, depth + 1]);
      }
    }
    return null;
  }

  /** Obliga a las bases abiertas a volver a leer groupedData. */
  refreshBases() {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (leaf.view.getViewType() !== "bases") return;
      const l = leaf as unknown as AnyObj;
      if (typeof l.rebuildView === "function") {
        void l.rebuildView();
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

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Dividir grupos en opciones únicas de lista")
      .setDesc(
        "Cuando una Base agrupa por una propiedad de lista, cada nota aparece en un grupo correspondiente a cada valor de la lista.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Unificación completa")
      .setDesc("«Main» y «main» forman un solo grupo; se unifican [[Main]], [[Carpeta/Main.md]] y [[Main|alias]]; y se ignora el # de las etiquetas.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.caseInsensitive).onChange(async (v) => {
          this.plugin.settings.caseInsensitive = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Orden de los grupos")
      .setDesc("«Orden de Bases» respeta el orden de agrupación nativo. Las notas dentro de cada grupo siempre mantienen el orden de la Base.")
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
            this.plugin.settings.sortMode = v as GroupSortMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Arrastre en Kanban").setHeading();

    new Setting(containerEl)
      .setName("Qué hacer con la lista al mover una tarjeta de columna")
      .setDesc(
        "Si no se puede saber de qué columna salió la tarjeta, la opción 3 se comporta como la 2.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            "replace-all": "1. Sustituir todo por la columna nueva",
            add: "2. Agregar la columna nueva a las anteriores",
            "replace-origin": "3. Reemplazar columna de origen por columna nueva",
          })
          .setValue(this.plugin.settings.dragMode)
          .onChange(async (v) => {
            this.plugin.settings.dragMode = v as DragMode;
            await this.plugin.saveSettings();
          }),
      );
  }
}
