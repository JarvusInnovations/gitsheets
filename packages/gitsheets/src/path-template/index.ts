// Path templates — the exported `Template` and its query-tree walk.
// See specs/behaviors/path-templates.md for the contract.
//
// Parsing and rendering happen in the core (`gitsheets-core`'s
// `path_template` module, through the napi `CompiledDefinition`): a compiled
// template holds its own embedded engine, and every expression component runs
// there — never in this runtime. This module only walks a tree for
// `queryTree`, asking the core to render each component against the partial
// query. See specs/rust-core.md "Embedded code execution".

import { addon, callCore } from '../core.js';
import { GitsheetsError, PathTemplateError } from '../errors.js';

// --- Public types ---

export type RecordLike = Record<string, unknown>;

export interface PathTemplateBlob {
  readonly isBlob: boolean;
}

export interface PathTemplateTree {
  readonly isTree: boolean;
  getChild(name: string): Promise<PathTemplateTree | PathTemplateBlob | undefined>;
  getChildren(): Promise<Record<string, PathTemplateTree | PathTemplateBlob>>;
  getBlobMap(): Promise<Record<string, PathTemplateBlob>>;
}

export interface PathTemplateQueryResult {
  readonly path: string;
  readonly blob: PathTemplateBlob;
}

type CompiledDefinition = InstanceType<typeof addon.CompiledDefinition>;

// --- Core calls ---

/**
 * Run a core call for `template`. Typed core errors (`PathTemplateError`,
 * `ConfigError`) pass through `callCore`; a value the core cannot marshal (a
 * function, a symbol, a `null` array element, …) surfaces as
 * `PathTemplateError('path_render_failed')` — the record cannot be rendered,
 * exactly as it could not be written.
 */
function renderCall<R>(template: string, fn: () => R): R {
  try {
    return callCore(fn);
  } catch (err) {
    if (err instanceof Error && !(err instanceof GitsheetsError)) {
      throw new PathTemplateError(
        'path_render_failed',
        `cannot render "${template}": ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Drop function-valued entries (at any table depth) from a query before it
 * crosses to the core: a function filter value is opaque to pruning, exactly
 * like an absent field (specs/behaviors/path-templates.md "Function-valued
 * filter entries"), and it cannot be marshalled.
 */
function stripFunctions(query: RecordLike): RecordLike {
  const out: RecordLike = {};
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'function') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = stripFunctions(v as RecordLike);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// --- Tree helpers ---

function isBlob(x: PathTemplateTree | PathTemplateBlob): x is PathTemplateBlob {
  return (x as PathTemplateBlob).isBlob === true;
}

function isTree(x: PathTemplateTree | PathTemplateBlob): x is PathTemplateTree {
  return (x as PathTemplateTree).isTree === true;
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

// --- Template class ---

// Per isolate: a worker thread loads its own copy of this module, so each
// thread compiles its own templates into its own engine (boa contexts are
// single-threaded).
const TEMPLATE_CACHE = new Map<string, Template>();

export class Template {
  static fromString(templateString: string): Template {
    const cached = TEMPLATE_CACHE.get(templateString);
    if (cached) return cached;
    const compiled = renderCall(
      templateString,
      () => new addon.CompiledDefinition(templateString),
    );
    const instance = new Template(templateString, compiled);
    TEMPLATE_CACHE.set(templateString, instance);
    return instance;
  }

  /** Clear the global parse cache. Test-only escape hatch. */
  static clearCache(): void {
    TEMPLATE_CACHE.clear();
  }

  readonly source: string;
  readonly #compiled: CompiledDefinition;
  readonly #componentCount: number;
  #fieldNames: readonly string[] | undefined;
  #staticFieldNames: readonly string[] | undefined;

  private constructor(source: string, compiled: CompiledDefinition) {
    this.source = source;
    this.#compiled = compiled;
    this.#componentCount = compiled.componentCount();
  }

  get componentCount(): number {
    return this.#componentCount;
  }

  /**
   * Names of record fields that contribute to rendering this template.
   * Used by consumers that need to identify a record by its template-rendered
   * path (e.g., `Sheet.patch` query auto-derivation in the CLI).
   *
   * For `field`-style components, the name is the field directly. For
   * expression components, a best-effort identifier scan returns any bare
   * identifiers in the expression source — excluding JS-language keywords
   * and globals. False positives (e.g., for `(slug || legacy_id)`) are fine
   * because the caller still passes only known input fields downstream.
   */
  getFieldNames(): readonly string[] {
    this.#fieldNames ??= this.#compiled.fieldNames();
    return [...this.#fieldNames];
  }

  /**
   * The template's *static* field names — plain / recursive field references
   * and date-bucket base fields, in source order, de-duplicated. Expression
   * parts are skipped: which fields an expression needs is not statically
   * decidable. This is the set the open-time template-coherence check requires
   * the schema to list (specs/behaviors/path-templates.md "Template fields
   * must be schema-required"); `infer` / `migrate-config` always put these in
   * the written schema's `required`.
   */
  getStaticFieldNames(): readonly string[] {
    this.#staticFieldNames ??= this.#compiled.staticFieldNames();
    return [...this.#staticFieldNames];
  }

  /**
   * Render the template against a full record, in the core.
   *
   * @throws PathTemplateError(`path_render_failed`) when any component is unrenderable.
   * @throws PathTemplateError(`path_invalid_chars`) when a rendered segment contains
   *         disallowed characters.
   */
  render(record: RecordLike): string {
    return renderCall(this.source, () => this.#compiled.renderPath(record));
  }

  /** Render component `index` against a partial query; `undefined` = un-renderable. */
  #renderComponent(index: number, query: RecordLike): string | undefined {
    return renderCall(this.source, () => this.#compiled.renderComponent(index, query)) ?? undefined;
  }

  /**
   * Walk a tree yielding records that may match the query.
   *
   * Pruning: when the query supplies the inputs to render a component, the
   * walk descends into only that subtree. When a component is unrenderable
   * against the partial query, the walk expands across all subtrees at that
   * level. The caller still applies the full equality filter on the yielded
   * record contents.
   *
   * `opts.extension` selects which file extension marks a record blob (the
   * leaf of the path). Defaults to `.toml`; markdown sheets pass `.md` (and
   * `.mdx` for mdx). The extension is stripped from the yielded `path`.
   */
  async *queryTree(
    tree: PathTemplateTree | undefined,
    query: RecordLike,
    opts: { pathPrefix?: string; depth?: number; extension?: string } = {},
  ): AsyncGenerator<PathTemplateQueryResult> {
    if (!tree) return;
    yield* this.#walk(tree, stripFunctions(query), opts);
  }

  async *#walk(
    tree: PathTemplateTree,
    query: RecordLike,
    opts: { pathPrefix?: string; depth?: number; extension?: string },
  ): AsyncGenerator<PathTemplateQueryResult> {
    const pathPrefix = opts.pathPrefix ?? '';
    const depth = opts.depth ?? 0;
    const extension = opts.extension ?? '.toml';
    const extLen = extension.length;

    const numComponents = this.#componentCount;
    let currentTree: PathTemplateTree = tree;
    let currentPrefix = pathPrefix;

    for (let i = depth; i < numComponents; i++) {
      const isLast = i + 1 === numComponents;
      const rendered = this.#renderComponent(i, query);

      if (isLast) {
        if (rendered !== undefined) {
          const child = await currentTree.getChild(`${rendered}${extension}`);
          if (child && isBlob(child)) {
            yield { path: joinPath(currentPrefix, rendered), blob: child };
          }
          return;
        }

        const children = this.#compiled.isRecursiveComponent(i)
          ? await currentTree.getBlobMap()
          : await currentTree.getChildren();

        let attachmentPrefix: string | undefined;
        // `getChildren()` returns a plain object of own enumerable entries
        // (the binding hands back plain data, not prototype-loaded handles).
        const allKeys: string[] = [];
        for (const k in children) allKeys.push(k);
        const sortedKeys = allKeys.sort();

        for (const childPath of sortedKeys) {
          if (!childPath.endsWith(extension)) continue;
          if (attachmentPrefix && childPath.startsWith(attachmentPrefix)) continue;

          const child = children[childPath];
          if (!child || !isBlob(child)) continue;

          const childName = childPath.slice(0, -extLen);
          attachmentPrefix = `${childName}/`;
          yield { path: joinPath(currentPrefix, childName), blob: child };
        }
        return;
      }

      if (rendered !== undefined) {
        const next = await currentTree.getChild(rendered);
        if (!next || !isTree(next)) return;
        currentTree = next;
        currentPrefix = joinPath(currentPrefix, rendered);
        continue;
      }

      // Unrenderable intermediate component: expand across all subtree children.
      const children = await currentTree.getChildren();
      for (const name in children) {
        const child = children[name];
        if (!child || !isTree(child)) continue;
        yield* this.#walk(child, query, {
          pathPrefix: joinPath(currentPrefix, name),
          depth: i + 1,
          extension,
        });
      }
      return;
    }
  }
}
