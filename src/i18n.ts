/**
 * Interface translations. English is the default; Spanish is used when the
 * Obsidian app language is Spanish (`es`, `es-MX`, ...).
 */

const en = {
  commandToggle: "Toggle group splitting in bases",
  noticeEnabled: "Group splitting enabled",
  noticeDisabled: "Group splitting disabled",
  noticeSourceNotFound:
    "Native split groups: the source column was not found. The new value was added without removing any others.",

  enabledName: "Split groups into single list options",
  enabledDesc:
    "When a base is grouped by a list property, each note appears in one group for every value in the list.",

  caseName: "Merge equivalent values",
  caseDesc:
    "\"Main\" and \"main\" form a single group; [[main]], [[folder/main.md]] and [[main|alias]] are merged; and the # of tags is ignored.",

  sortName: "Group order",
  sortDesc:
    "\"Obsidian's order\" follows the choice in the Group menu. Notes inside each group keep the base's order.",
  sortNative: "Obsidian's order",
  sortMost: "Most notes first",
  sortFewest: "Fewest notes first",

  dragHeading: "Kanban drag",
  dragName: "What to do with the list when a card moves to another column",
  dragDesc: "If the card's source column cannot be determined, option 3 behaves like option 2.",
  dragReplaceAll: "1. Replace everything with the new column",
  dragAdd: "2. Add the new column to the previous ones",
  dragReplaceOrigin: "3. Replace the source column with the new column",

  debugName: "Diagnostics",
  debugDesc:
    "Records how Bases hands over its groups so a problem can be reported. Turn it on, reproduce the problem, then run the command \"Copy diagnostics\". Leave it off otherwise.",
  commandDiag: "Copy diagnostics",
  noticeDiagCopied: "Diagnostics copied to the clipboard",
  noticeDiagFailed: "Could not copy to the clipboard; the diagnostics were written to the developer console",
};

export type TKey = keyof typeof en;

const es: Record<TKey, string> = {
  commandToggle: "Activar/desactivar la división de grupos en bases",
  noticeEnabled: "División de grupos activada",
  noticeDisabled: "División de grupos desactivada",
  noticeSourceNotFound:
    "Native split groups: no se encontró la columna de origen. Se agregó el valor nuevo sin quitar ninguno.",

  enabledName: "Dividir grupos en opciones únicas de lista",
  enabledDesc:
    "Cuando una base agrupa por una propiedad de lista, cada nota aparece en un grupo correspondiente a cada valor de la lista.",

  caseName: "Combinar valores equivalentes",
  caseDesc:
    "«Main» y «main» forman un solo grupo; se unifican [[main]], [[carpeta/main.md]] y [[main|alias]]; y se ignora el # de las etiquetas.",

  sortName: "Orden de los grupos",
  sortDesc:
    "\"Orden de Obsidian\" sigue la opción del menú Grupo. Las notas dentro de cada grupo mantienen el orden de la base.",
  sortNative: "Orden de Obsidian",
  sortMost: "Más notas primero",
  sortFewest: "Menos notas primero",

  dragHeading: "Arrastre en kanban",
  dragName: "Qué hacer con la lista al mover una tarjeta de columna",
  dragDesc: "Si no se puede saber de qué columna salió la tarjeta, la opción 3 se comporta como la 2.",
  dragReplaceAll: "1. Sustituir todo por la columna nueva",
  dragAdd: "2. Agregar la columna nueva a las anteriores",
  dragReplaceOrigin: "3. Reemplazar columna de origen por columna nueva",

  debugName: "Diagnóstico",
  debugDesc:
    "Registra cómo maneja Bases sus grupos para poder reportar un problema. Actívalo, reproduce el problema y ejecuta el comando \"Copiar diagnóstico\". Déjalo desactivado el resto del tiempo.",
  commandDiag: "Copiar diagnóstico",
  noticeDiagCopied: "Diagnóstico copiado al portapapeles",
  noticeDiagFailed: "No se pudo copiar al portapapeles; el diagnóstico se escribió en la consola de desarrollador",
};

export type Locale = "en" | "es";

export const LOCALES: Record<Locale, Record<TKey, string>> = { en, es };

/** Maps an Obsidian language code (`es`, `es-MX`, `en-GB`, ...) to a supported locale. */
export function pickLocale(lang: string | null | undefined): Locale {
  return /^es([-_]|$)/i.test((lang ?? "").trim()) ? "es" : "en";
}

/**
 * Returns a translate function. The language is read on every call, so a change of
 * the app language is picked up the next time a string is shown.
 */
export function makeT(getLang: () => string): (key: TKey) => string {
  return (key) => LOCALES[pickLocale(getLang())][key];
}
