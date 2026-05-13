<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef } from "vue";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext } from "@/lib/sqlCompletion";
import { extractIdentifierAt, isSqlKeyword, matchTable } from "@/lib/sqlNavigation";
import { loadEditorTheme, editorFontTheme } from "@/lib/editorThemes";
import type { SqlCompletionColumn } from "@/lib/sqlCompletion";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  database?: string;
  dialect?: "mysql" | "postgres" | "sqlserver";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  readOnly?: boolean;
  forceWordWrap?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  formatError: [message: string];
  execute: [sql: string];
  clickTable: [tableName: string];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const MAX_COMPLETION_TABLES = 200;
let editorViewModule: typeof import("@codemirror/view") | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;

// Completion cache
let cachedTables: Array<{ name: string; schema?: string; type?: "table" | "view" }> = [];
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();

function setFontSize(size: number) {
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
  const ss = settingsStore.editorSettings;
  ss.fontSize = next;
  settingsStore.updateEditorSettings({ fontSize: next });
  if (view.value && fontThemeComp && editorViewModule) {
    view.value.dispatch({
      effects: [
        fontThemeComp.reconfigure(
          editorFontTheme(editorViewModule.EditorView, next, ss.fontFamily, {
            fixedHeight: true,
            scrollable: true,
          }),
        ),
      ],
    });
  }
}

function zoomIn() {
  setFontSize(settingsStore.editorSettings.fontSize + 1);
}

function zoomOut() {
  setFontSize(settingsStore.editorSettings.fontSize - 1);
}

function resetZoom() {
  setFontSize(13);
}

function wordWrapExtension() {
  if (!editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? editorViewModule.EditorView.lineWrapping : [];
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function executableSqlFromView(currentView: EditorViewType): string {
  return resolveExecutableSql(currentView.state.doc.toString(), selectedSqlFromView(currentView));
}

async function formatCurrentSql() {
  const currentView = view.value;
  if (!currentView) return;

  const selection = currentView.state.selection.main;
  const formatsSelection = !selection.empty;
  const from = formatsSelection ? selection.from : 0;
  const to = formatsSelection ? selection.to : currentView.state.doc.length;
  const source = currentView.state.sliceDoc(from, to);
  if (!source.trim()) return;

  try {
    const formatted = await formatSqlText(source, props.formatDialect ?? props.dialect ?? "generic");
    if (formatted === source) return;
    currentView.dispatch({
      changes: { from, to, insert: formatted },
      selection: formatsSelection
        ? { anchor: from, head: from + formatted.length }
        : { anchor: from + formatted.length },
    });
  } catch (e: any) {
    emit("formatError", String(e?.message || e));
  }
}

async function provideSqlCompletions(currentState: import("@codemirror/state").EditorState, position: number) {
  if (!props.connectionId || !props.database) return null;

  try {
    const fullDoc = currentState.doc.toString();
    const completionContext = getSqlCompletionContext(fullDoc, position);
    const shouldLoadTables = completionContext.suggestTables || !!completionContext.qualifier;
    let tables = shouldLoadTables
      ? await connectionStore.listCompletionTables(
          props.connectionId,
          props.database,
          completionContext.qualifier || completionContext.prefix,
          MAX_COMPLETION_TABLES,
        )
      : cachedTables;

    // If qualifier didn't match any table names, try it as a schema name
    let qualifierIsSchema = false;
    if (completionContext.qualifier && completionContext.suggestTables && tables.length === 0) {
      const schemaTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        completionContext.prefix,
        MAX_COMPLETION_TABLES,
        completionContext.qualifier,
      );
      if (schemaTables.length > 0) {
        tables = schemaTables;
        qualifierIsSchema = true;
      }
    }

    // Collect referenced tables — enrich with schema from filtered table lookup
    let refs = completionContext.referencedTables.map((rt) => {
      // If no schema, look it up in the cached tables
      if (!rt.schema) {
        const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
        if (cached && cached.schema) {
          return { ...rt, schema: cached.schema };
        }
      }
      return rt;
    });
    const unresolvedRefs = refs.filter((rt) => !rt.schema);
    if (unresolvedRefs.length > 0) {
      const lookupGroups = await Promise.all(
        unresolvedRefs.map((rt) =>
          connectionStore.listCompletionTables(props.connectionId!, props.database!, rt.name, 20),
        ),
      );
      const lookupTables = lookupGroups.flat();
      refs = refs.map((rt) => {
        if (rt.schema) return rt;
        const matched = lookupTables.find((table) => table.name.toLowerCase() === rt.name.toLowerCase());
        return matched?.schema ? { ...rt, schema: matched.schema } : rt;
      });
    }

    // If no referenced tables but qualifier exists, infer table from tables list
    if (refs.length === 0 && completionContext.qualifier) {
      const q = completionContext.qualifier.toLowerCase();
      const matched = tables.filter((t) => t.name.toLowerCase() === q || t.name.toLowerCase().endsWith("." + q));
      refs = matched.map((t) => ({ name: t.name, schema: t.schema }));
    }

    await Promise.all(
      refs.map(async (refTable) => {
        const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
        if (cachedColumnsByTable.has(cacheKey)) {
          return;
        }
        try {
          const columns = await connectionStore.listCompletionColumns(
            props.connectionId!,
            props.database!,
            refTable.name,
            refTable.schema,
          );
          cachedColumnsByTable.set(cacheKey, columns);
        } catch (e) {
          console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
        }
      }),
    );

    // Build columnsByTable from persistent cache — only include columns for referenced tables
    const columnsByTable = new Map<string, SqlCompletionColumn[]>();
    for (const refTable of refs) {
      const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
      const cached = cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
      }
    }

    const effectiveContext = qualifierIsSchema
      ? { ...completionContext, qualifier: undefined, suggestTables: true, suggestColumns: false }
      : completionContext;

    const items = buildSqlCompletionItemsFromContext(effectiveContext, {
      tables,
      columnsByTable,
    });

    if (items.length === 0) return null;

    return {
      from: position - completionContext.prefix.length,
      options: items.map((item) => ({
        label: item.label,
        type: item.type === "keyword" ? "keyword" : item.type === "table" ? "class" : "property",
        detail: item.detail,
        boost: item.boost,
      })),
      validFor: /^[\w$]*$/,
    };
  } catch {
    return null;
  }
}

async function refreshCompletionCache() {
  cachedTables = [];
  cachedColumnsByTable.clear();
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap },
    { EditorState, Compartment, Prec },
    { sql, MSSQL, MySQL, PostgreSQL, SQLDialect },
    { basicSetup },
    { autocompletion, startCompletion, closeBrackets, closeBracketsKeymap },
    { indentWithTab },
    { bracketMatching },
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-sql"),
    import("codemirror"),
    import("@codemirror/autocomplete"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
  ]);
  editorViewModule = { EditorView, keymap } as typeof import("@codemirror/view");
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  readOnlyComp = new Compartment();

  const ss = settingsStore.editorSettings;

  const baseDialect = props.dialect === "postgres" ? PostgreSQL : props.dialect === "sqlserver" ? MSSQL : MySQL;
  const extraKeywords =
    "PIVOT UNPIVOT EXCLUDE REPLACE QUALIFY ASOF POSITIONAL ANTI SEMI SAMPLE TABLESAMPLE STRUCT MAP LIST ARRAY LAMBDA UNNEST LATERAL FILTER RECURSIVE SUMMARIZE PRAGMA READ_CSV READ_PARQUET READ_JSON DESCRIBE SHOW COPY EXPORT IMPORT";
  const dialect = SQLDialect.define({
    ...baseDialect.spec,
    keywords: (baseDialect.spec.keywords || "") + " " + extraKeywords,
  });

  const runKeymap = keymap.of([
    {
      key: "Mod-=",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod-+",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod--",
      run: () => {
        zoomOut();
        return true;
      },
    },
    {
      key: "Mod-0",
      run: () => {
        resetZoom();
        return true;
      },
    },
    {
      key: "Mod-Enter",
      run: () => {
        if (view.value) emit("execute", executableSqlFromView(view.value));
        return true;
      },
    },
  ]);

  const theme = await loadEditorTheme(ss.theme);

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      sql({ dialect }),
      autocompletion({
        activateOnTyping: true,
        override: [async (context: CompletionContext) => provideSqlCompletions(context.state, context.pos)],
      }),
      codeMirrorTheme.of(theme),
      closeBrackets(),
      bracketMatching(),
      Prec.highest(keymap.of([...closeBracketsKeymap, indentWithTab])),
      runKeymap,
      wordWrapComp.of(props.forceWordWrap || ss.wordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
          let insertedText = "";
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            insertedText += inserted.toString();
          });
          if (insertedText.endsWith(".")) {
            startCompletion(update.view);
          }
        }
        if (update.selectionSet || update.docChanged) {
          emit("selectionChange", selectedSqlFromView(update.view));
          emit("cursorChange", update.state.selection.main.head);
        }
      }),
      fontThemeComp.of(
        editorFontTheme(EditorView, ss.fontSize, ss.fontFamily, {
          fixedHeight: true,
          scrollable: true,
        }),
      ),
      EditorView.domEventHandlers({
        wheel(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
          event.preventDefault();
          if (event.deltaY < 0) zoomIn();
          else if (event.deltaY > 0) zoomOut();
          return true;
        },
        mousedown: (event: MouseEvent) => {
          // Click without modifier -> close column panel
          if (!event.metaKey && !event.ctrlKey) {
            if (event.button === 0) {
              emit("closeColumnPanel");
            }
            return false;
          }
          // Only handle Ctrl/Cmd + left click
          if (event.button !== 0) return false;

          const currentView = view.value;
          if (!currentView || !props.connectionId || !props.database) {
            return false;
          }

          // Use posAtCoords for accurate click position
          const coords = { x: event.clientX, y: event.clientY };
          const pos = currentView.posAtCoords(coords);
          if (pos == null) {
            return false;
          }

          const doc = currentView.state.doc.toString();
          const identifier = extractIdentifierAt(doc, pos);
          if (!identifier) {
            return false;
          }
          if (isSqlKeyword(identifier)) {
            return false;
          }

          // Prevent default, resolve async
          event.preventDefault();
          setTimeout(async () => {
            try {
              // Ensure table cache is populated
              if (cachedTables.length === 0) {
                cachedTables = await connectionStore.listCompletionTables(
                  props.connectionId!,
                  props.database!,
                  identifier,
                  MAX_COMPLETION_TABLES,
                );
              }

              // 1. Check if it's a table name
              const matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit(
                  "clickTable",
                  matchedTable.schema ? `${matchedTable.schema}.${matchedTable.name}` : matchedTable.name,
                );
                return;
              }

              // 2. Parse SQL at click position to get referenced tables
              const context = getSqlCompletionContext(doc, pos);
              let referencedTables = context.referencedTables;
              // Enrich referenced tables with schema from cachedTables
              referencedTables = referencedTables.map((rt) => {
                const cached = cachedTables.find((ct) => ct.name.toLowerCase() === rt.name.toLowerCase());
                if (cached && cached.schema && !rt.schema) {
                  return { ...rt, schema: cached.schema };
                }
                return rt;
              });

              // Check if identifier has a qualifier (e.g., c.card_name)
              const qualifierMatch = /^(.+)\.(.+)$/.exec(identifier);
              const qualifier = qualifierMatch ? qualifierMatch[1] : null;
              const colName = qualifierMatch ? qualifierMatch[2] : identifier;
              const colLower = colName.toLowerCase();

              if (referencedTables.length === 0) {
                return;
              }
              // 3. Fetch columns — if qualifier, only check matching table; otherwise check all
              const tablesToCheck = qualifier
                ? referencedTables.filter(
                    (rt) =>
                      rt.alias?.toLowerCase() === qualifier.toLowerCase() ||
                      rt.name.toLowerCase() === qualifier.toLowerCase(),
                  )
                : referencedTables;

              if (tablesToCheck.length === 0 && qualifier) {
                return;
              }

              const matchedCols: Array<{ name: string; table: string; schema?: string }> = [];

              for (const refTable of tablesToCheck) {
                const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;

                // Use persistent column cache; fetch only if missing
                let cols = cachedColumnsByTable.get(cacheKey);
                if (!cols) {
                  try {
                    cols = await connectionStore.listCompletionColumns(
                      props.connectionId!,
                      props.database!,
                      refTable.name,
                      refTable.schema,
                    );
                    cachedColumnsByTable.set(cacheKey, cols);
                  } catch {
                    continue;
                  }
                }
                for (const col of cols) {
                  if (col.name.toLowerCase() === colLower) {
                    matchedCols.push({
                      name: col.name,
                      table: refTable.name,
                      schema: col.schema || refTable.schema,
                    });
                  }
                }
              }

              if (matchedCols.length > 0) {
                emit("clickColumn", matchedCols);
              }
            } catch (e) {
              console.error("[DBX] Ctrl+click error:", e);
            }
          }, 0);
          return true;
        },
      }),
    ],
  });

  view.value = new EditorView({ state, parent: editorRef.value });

  cachedTables = [];
});

watch(
  () => props.modelValue,
  (val) => {
    if (view.value && val !== view.value.state.doc.toString()) {
      view.value.dispatch({
        changes: { from: 0, to: view.value.state.doc.length, insert: val },
      });
    }
  },
);

watch(
  () => props.formatRequestId,
  (val, oldVal) => {
    if (val && val !== oldVal) formatCurrentSql();
  },
);

watch(
  () => props.connectionId,
  () => {
    refreshCompletionCache();
  },
);

watch(
  () => props.database,
  () => {
    refreshCompletionCache();
  },
);

watch(
  () => props.forceWordWrap,
  () => {
    if (!view.value || !wordWrapComp) return;
    view.value.dispatch({
      effects: wordWrapComp.reconfigure(wordWrapExtension()),
    });
  },
);

// Reactively apply editor settings changes
watch(
  () => settingsStore.editorSettings,
  async (ss) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !editorViewModule) return;
    const themeExt = await loadEditorTheme(ss.theme);
    view.value.dispatch({
      effects: [
        codeMirrorTheme.reconfigure(themeExt),
        wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []),
        fontThemeComp.reconfigure(
          editorFontTheme(editorViewModule.EditorView, ss.fontSize, ss.fontFamily, {
            fixedHeight: true,
            scrollable: true,
          }),
        ),
      ],
    });
  },
  { deep: true },
);

onBeforeUnmount(() => {
  view.value?.destroy();
});
</script>

<template>
  <div ref="editorRef" data-query-editor-root class="h-full w-full overflow-hidden" />
</template>
