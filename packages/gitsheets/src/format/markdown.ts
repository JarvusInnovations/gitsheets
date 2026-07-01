// Markdown format — records are stored as `.md` files with TOML frontmatter
// delimited by `+++` (Hugo-style) and one designated field holding the body.
//
// The whole frontmatter + body codec is the Rust core's bytes-authority
// (`gitsheets-core::codec`, exposed as `markdownSerialize` / `markdownParse` /
// `markdownParseHeaderOnly` and the H1 helpers). This module is a thin
// marshalling shell over it. Body NORMALIZATION is native: on serialize the
// core runs the embedded `dprint-plugin-markdown` formatter (the pinned
// aggressive `textWrap: never` config) rather than the former host-side
// `markdownlint --fix` pass — so body bytes are identical across bindings.
// Switching off the `markdownlint` pass is a one-time documented body
// re-baseline. See specs/behaviors/content-types.md and specs/rust-core.md.
//
// **Trailing newline convention.** The on-disk file always ends with exactly
// one `\n`; the round-tripped body therefore carries no trailing newline
// (`'hi\n'` → `'hi'`). The core codec preserves this convention.

import { addon, callCore } from '../core.js';
import type { RecordLike } from '../path-template/index.js';
import type { Format, FormatConfig } from './index.js';

function bodyFieldName(config: FormatConfig): string {
  if (!config.body) {
    throw new Error(
      `markdown format requires [gitsheet.format].body to be set to the field name holding the body text`,
    );
  }
  return config.body;
}

/**
 * Extract the first ATX-style H1 from a markdown body, or `undefined` if
 * absent. Delegates to the core (`markdownExtractH1`), which returns `null` for
 * "no H1"; surfaced as `undefined` to preserve the JS contract.
 */
export function extractFirstH1(body: string): string | undefined {
  return addon.markdownExtractH1(body) ?? undefined;
}

/**
 * Rewrite (or prepend) the first ATX H1 of a markdown body to `newTitle`. Used
 * by `Sheet.patch` to reconcile a title-only delta into the body. Delegates to
 * the core (`markdownRewriteH1`).
 */
export function rewriteLeadingH1(body: string, newTitle: string): string {
  return addon.markdownRewriteH1(body, newTitle);
}

export const markdownFormat: Format = {
  extension: '.md',

  // Async to preserve the historical `Format.serialize` promise contract (the
  // core call itself is synchronous).
  async serialize(record: RecordLike, config: FormatConfig): Promise<string> {
    const bodyField = bodyFieldName(config);
    // Body-presence type guard — kept host-side so a non-string body surfaces
    // as the historical `TypeError` (rather than the core's typed
    // ValidationError). See specs/behaviors/content-types.md.
    const bodyRaw = record[bodyField];
    if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
      throw new TypeError(
        `markdown format: record.${bodyField} must be a string, got ${typeof bodyRaw}`,
      );
    }
    // `markdownlint === false` disables body normalization (frame verbatim).
    const normalize = config.markdownlint !== false;
    return callCore(() =>
      addon.markdownSerialize(record, bodyField, config.title ?? null, normalize),
    );
  },

  parse(text: string, config: FormatConfig): RecordLike {
    const bodyField = bodyFieldName(config);
    return callCore(() =>
      addon.markdownParse(text, bodyField, config.title ?? null),
    ) as RecordLike;
  },

  parseHeaderOnly(text: string, config: FormatConfig): RecordLike {
    const bodyField = bodyFieldName(config);
    return callCore(() => addon.markdownParseHeaderOnly(text, bodyField)) as RecordLike;
  },
};
