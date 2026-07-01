// Format dispatch — pluggable serialize / parse interface for sheet records.
//
// A sheet's `[gitsheet.format]` config (default: `type = 'toml'`) selects how
// records are encoded on disk. The TOML format is the default and matches the
// v1.0/v1.1 behavior; the markdown format encodes records as `.md` files with
// TOML frontmatter and a designated body field. See specs/behaviors/content-types.md.

import type { RecordLike } from '../path-template/index.js';

/**
 * Per-format config sourced from `[gitsheet.format]` in the sheet config.
 * Concrete formats receive this verbatim and ignore the parts they don't use.
 */
export interface FormatConfig {
  /** Discriminator: 'toml' (default) | 'markdown' | 'mdx'. */
  readonly type: string;
  /** Field name holding the body text (markdown formats only). */
  readonly body?: string;
  /**
   * Field name to denormalize from the body's first H1 (markdown formats
   * only). When set, the format pipeline:
   *
   *   - Extracts the first H1 from the body (line matching `^#\s+...`).
   *   - Enforces the invariant `record[title] === body's first H1` (via the core
   *     codec's `title` parameter) — writes with a disagreeing title, or a body
   *     with no leading H1, throw `ValidationError`.
   *
   * See `Sheet.patch` for how patch reconciles title-only or body-only
   * deltas against the invariant.
   */
  readonly title?: string;
  /**
   * Whether to normalize the body on write with the native dprint formatter
   * (markdown/mdx only). Default `true`; `normalize = false` frames the body
   * verbatim. See specs/behaviors/content-types.md.
   */
  readonly normalize?: boolean;
  /**
   * @deprecated Legacy pre-core toggle, superseded by {@link normalize}. Retained
   * for type back-compat; no longer consulted on the write path (the core codec
   * owns body normalization). Markdown formats only.
   */
  readonly markdownlint?: Readonly<Record<string, unknown>> | false;
}

/**
 * Implementation surface every format provides. Symmetrical:
 * - `serialize` produces the on-disk bytes for a record
 * - `parse` decodes the on-disk bytes back into a record
 * - `parseHeaderOnly` is an optimization for bulk reads where only the
 *   "header" portion (TOML for `toml`, frontmatter for `markdown`) is needed
 */
export interface Format {
  /** File extension this format writes records as, including the leading dot. */
  readonly extension: string;

  /** Serialize a record to its on-disk text form. May normalize content. */
  serialize(record: RecordLike, config: FormatConfig): Promise<string> | string;

  /** Parse on-disk bytes into a full record. */
  parse(text: string, config: FormatConfig): RecordLike;

  /**
   * Parse only the structured-fields portion of the record, skipping any
   * heavy "body" content. For `toml`, identical to `parse`. For `markdown`,
   * stops after the frontmatter closing delimiter. Used by lazy-body reads.
   */
  parseHeaderOnly(text: string, config: FormatConfig): RecordLike;
}

// --- Registry ---

const REGISTRY = new Map<string, Format>();

export function registerFormat(name: string, format: Format): void {
  REGISTRY.set(name, format);
}

export function getFormat(type: string): Format {
  const f = REGISTRY.get(type);
  if (!f) {
    throw new Error(
      `unknown sheet format ${JSON.stringify(type)} — registered: ${[...REGISTRY.keys()].join(', ')}`,
    );
  }
  return f;
}

export function hasFormat(type: string): boolean {
  return REGISTRY.has(type);
}

/**
 * Resolve a `FormatConfig` from the raw `[gitsheet.format]` block. Validates
 * the discriminator and any format-specific required fields.
 *
 * Returns `null` (with the implicit default 'toml' format) when the caller
 * didn't supply a format block at all.
 */
export function resolveFormatConfig(raw: unknown): FormatConfig {
  if (raw === undefined || raw === null) {
    return { type: 'toml' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`[gitsheet.format] must be a table, got ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const typeRaw = obj['type'];
  const type = typeof typeRaw === 'string' ? typeRaw : 'toml';
  const out: {
    type: string;
    body?: string;
    title?: string;
    normalize?: boolean;
    markdownlint?: Readonly<Record<string, unknown>> | false;
  } = { type };
  if (typeof obj['body'] === 'string') out.body = obj['body'];
  if (typeof obj['title'] === 'string') out.title = obj['title'];
  // `normalize = false` disables native body normalization (specs/behaviors/
  // content-types.md) — the toggle the core codec honors on the write path.
  if (typeof obj['normalize'] === 'boolean') out.normalize = obj['normalize'];
  if (obj['markdownlint'] === false) {
    out.markdownlint = false;
  } else if (
    obj['markdownlint'] !== undefined &&
    typeof obj['markdownlint'] === 'object' &&
    !Array.isArray(obj['markdownlint'])
  ) {
    out.markdownlint = obj['markdownlint'] as Readonly<Record<string, unknown>>;
  }
  return out;
}

// --- Register the built-in formats on import ---

import { tomlFormat } from './toml.js';
import { markdownFormat } from './markdown.js';

registerFormat('toml', tomlFormat);
registerFormat('markdown', markdownFormat);
// `mdx` is the markdown format with a different file extension. Same parse +
// serialize pipeline; the extension is overridden per registry entry.
registerFormat('mdx', { ...markdownFormat, extension: '.mdx' });
