// Path template parser + renderer + query-tree traversal.
// See specs/behaviors/path-templates.md for the contract.

import { runInNewContext } from 'node:vm';

import { PathTemplateError } from '../errors.js';

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

// --- Internal model ---

interface LiteralPart {
  readonly kind: 'literal';
  readonly text: string;
}

interface FieldPart {
  readonly kind: 'field';
  readonly name: string;
  readonly recursive: boolean;
}

interface ExpressionPart {
  readonly kind: 'expression';
  readonly source: string;
  readonly evaluate: (record: RecordLike) => unknown;
}

type Part = LiteralPart | FieldPart | ExpressionPart;

interface Component {
  readonly parts: readonly Part[];
  /** True iff this component is exactly one recursive (`/**`) field part. */
  readonly recursive: boolean;
}

// --- Validation ---

// Windows-disallowed chars per specs/behaviors/path-templates.md.
const WINDOWS_INVALID = /[<>:"|?*\x00-\x1f]/;

// Same set plus `/` — segments rendered for non-recursive components must not
// contain `/`, since that would silently expand the rendered path's structure.
const SEGMENT_INVALID = /[<>:"|?*\x00-\x1f/]/;

function rejectInvalidChars(
  rendered: string,
  pattern: RegExp,
  source: string,
  componentIndex: number,
): void {
  const match = pattern.exec(rendered);
  if (match) {
    throw new PathTemplateError(
      'path_invalid_chars',
      `component ${componentIndex} of "${source}" rendered to ${JSON.stringify(rendered)}, ` +
        `which contains disallowed character ${JSON.stringify(match[0])}`,
    );
  }
}

// --- Expression compilation ---

const NOT_DEFINED_RE = / is not defined$/;

function compileExpression(source: string): (record: RecordLike) => unknown {
  let compiled: (record: RecordLike) => unknown;
  try {
    compiled = runInNewContext(
      `(record) => { with (record) { return (${source}) } }`,
    ) as (record: RecordLike) => unknown;
  } catch (err) {
    throw new PathTemplateError(
      'path_render_failed',
      `expression ${JSON.stringify(source)} failed to compile: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  return (record: RecordLike) => {
    try {
      return compiled(record);
    } catch (err) {
      // Per spec: missing identifiers are "un-renderable", not fatal —
      // that lets queries with partial fields walk the tree fully.
      if (err instanceof ReferenceError && NOT_DEFINED_RE.test(err.message)) {
        return undefined;
      }
      throw err;
    }
  };
}

// --- Value rendering ---

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'function') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toString();
  // Plain objects / arrays / Symbols: treat as un-renderable. Consumers
  // wanting a custom serialization use an expression component.
  return undefined;
}

function renderPart(part: Part, record: RecordLike): string | undefined {
  switch (part.kind) {
    case 'literal':
      return part.text;
    case 'field':
      return stringifyValue(record[part.name]);
    case 'expression':
      return stringifyValue(part.evaluate(record));
  }
}

function renderComponent(c: Component, record: RecordLike): string | undefined {
  let out = '';
  for (const part of c.parts) {
    const piece = renderPart(part, record);
    if (piece === undefined) return undefined;
    out += piece;
  }
  return out;
}

// --- Parser ---

const FIELD_NAME_RE = /^[a-zA-Z0-9_-]+(\/\*\*)?$/;

function parseTemplateString(source: string): readonly Component[] {
  const normalized = source.replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized === '') {
    throw new PathTemplateError('path_render_failed', 'path template is empty');
  }

  // Single-pass: structural `/` separates components, but `/` inside an
  // expression (notably the `/**` recursive suffix) belongs to the expression
  // and must not split segments.
  const segments: Part[][] = [[]];
  let pendingLiteral = '';
  let i = 0;

  const flushLiteral = () => {
    if (pendingLiteral) {
      segments[segments.length - 1]!.push({ kind: 'literal', text: pendingLiteral });
      pendingLiteral = '';
    }
  };

  while (i < normalized.length) {
    if (normalized.startsWith('${{', i)) {
      flushLiteral();
      i += 3;

      let exprSource = '';
      while (!normalized.startsWith('}}', i)) {
        if (i >= normalized.length) {
          throw new PathTemplateError(
            'path_render_failed',
            `expression "\${{${exprSource}" in template "${source}" was not closed with }}`,
          );
        }
        exprSource += normalized[i]!;
        i++;
      }
      exprSource = exprSource.trim();
      i += 2;

      if (FIELD_NAME_RE.test(exprSource)) {
        const recursive = exprSource.endsWith('/**');
        const name = recursive ? exprSource.slice(0, -3) : exprSource;
        segments[segments.length - 1]!.push({ kind: 'field', name, recursive });
      } else {
        segments[segments.length - 1]!.push({
          kind: 'expression',
          source: exprSource,
          evaluate: compileExpression(exprSource),
        });
      }
    } else if (normalized[i] === '/') {
      flushLiteral();
      segments.push([]);
      i++;
    } else {
      pendingLiteral += normalized[i]!;
      i++;
    }
  }
  flushLiteral();

  const components = segments.map((parts, idx) => buildComponent(parts, idx, source));

  // Recursive (`/**`) must be the last component if present.
  for (let i = 0; i < components.length - 1; i++) {
    if (components[i]!.recursive) {
      throw new PathTemplateError(
        'path_render_failed',
        `recursive component (\${{ ... /** }}) must be the final component of the template`,
      );
    }
  }

  return components;
}

function buildComponent(parts: readonly Part[], index: number, source: string): Component {
  if (parts.length === 0) {
    throw new PathTemplateError(
      'path_render_failed',
      `empty component at index ${index} of "${source}" — consecutive slashes are not allowed`,
    );
  }

  const onlyPart = parts.length === 1 ? parts[0]! : null;
  const componentRecursive =
    onlyPart !== null && onlyPart.kind === 'field' && onlyPart.recursive;

  if (!componentRecursive) {
    for (const part of parts) {
      if (part.kind === 'field' && part.recursive) {
        throw new PathTemplateError(
          'path_render_failed',
          `recursive field reference (\${{ ${part.name}/** }}) must be the only part of its component`,
        );
      }
    }
  }

  return { parts, recursive: componentRecursive };
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

// --- Identifier extraction (for Template.getFieldNames on ExpressionParts) ---

// Bare identifiers anywhere in the expression source. Members (`x.y`) match
// only `x` because the `\b` boundary follows a non-word char.
const IDENTIFIER_RE = /(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)/g;

const JS_RESERVED = new Set<string>([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'async', 'await',
  'of', 'Array', 'Boolean', 'Date', 'Number', 'Object', 'String', 'Math',
  'JSON', 'RegExp', 'Symbol', 'Promise', 'Map', 'Set', 'NaN', 'Infinity',
  'globalThis',
]);

function extractIdentifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IDENTIFIER_RE)) {
    const id = match[1]!;
    if (!JS_RESERVED.has(id)) out.push(id);
  }
  return out;
}

// --- Template class ---

const TEMPLATE_CACHE = new Map<string, Template>();

export class Template {
  static fromString(templateString: string): Template {
    const cached = TEMPLATE_CACHE.get(templateString);
    if (cached) return cached;
    const instance = new Template(templateString, parseTemplateString(templateString));
    TEMPLATE_CACHE.set(templateString, instance);
    return instance;
  }

  /** Clear the global parse cache. Test-only escape hatch. */
  static clearCache(): void {
    TEMPLATE_CACHE.clear();
  }

  readonly source: string;
  readonly #components: readonly Component[];

  private constructor(source: string, components: readonly Component[]) {
    this.source = source;
    this.#components = components;
  }

  get componentCount(): number {
    return this.#components.length;
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
    const seen = new Set<string>();
    for (const c of this.#components) {
      for (const p of c.parts) {
        if (p.kind === 'field') {
          seen.add(p.name);
        } else if (p.kind === 'expression') {
          for (const id of extractIdentifiers(p.source)) {
            seen.add(id);
          }
        }
      }
    }
    return [...seen];
  }

  /**
   * Render the template against a full record.
   *
   * @throws PathTemplateError(`path_render_failed`) when any component is unrenderable.
   * @throws PathTemplateError(`path_invalid_chars`) when a rendered segment contains
   *         disallowed characters.
   */
  render(record: RecordLike): string {
    const segments: string[] = [];
    for (let i = 0; i < this.#components.length; i++) {
      const c = this.#components[i]!;
      const rendered = renderComponent(c, record);
      if (rendered === undefined) {
        throw new PathTemplateError(
          'path_render_failed',
          `cannot render component ${i} of "${this.source}" — a required field or expression returned undefined`,
        );
      }
      rejectInvalidChars(rendered, c.recursive ? WINDOWS_INVALID : SEGMENT_INVALID, this.source, i);
      segments.push(rendered);
    }
    return segments.join('/');
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

    const pathPrefix = opts.pathPrefix ?? '';
    const depth = opts.depth ?? 0;
    const extension = opts.extension ?? '.toml';
    const extLen = extension.length;

    const numComponents = this.#components.length;
    let currentTree: PathTemplateTree = tree;
    let currentPrefix = pathPrefix;

    for (let i = depth; i < numComponents; i++) {
      const isLast = i + 1 === numComponents;
      const c = this.#components[i]!;
      const rendered = renderComponent(c, query);

      if (isLast) {
        if (rendered !== undefined) {
          const child = await currentTree.getChild(`${rendered}${extension}`);
          if (child && isBlob(child)) {
            yield { path: joinPath(currentPrefix, rendered), blob: child };
          }
          return;
        }

        const children = c.recursive
          ? await currentTree.getBlobMap()
          : await currentTree.getChildren();

        let attachmentPrefix: string | undefined;
        // `for...in` walks own + inherited enumerable keys. hologit's
        // getChildren() exposes loaded entries on the object's prototype
        // and only stages local mutations as own properties — Object.keys
        // would miss the loaded entries.
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
      // for...in to include hologit's prototype-loaded entries (see comment above).
      for (const name in children) {
        const child = children[name];
        if (!child || !isTree(child)) continue;
        yield* this.queryTree(child, query, {
          pathPrefix: joinPath(currentPrefix, name),
          depth: i + 1,
          extension,
        });
      }
      return;
    }
  }
}
