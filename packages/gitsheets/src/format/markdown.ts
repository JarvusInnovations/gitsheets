// Markdown format — records are stored as `.md` files with TOML frontmatter
// delimited by `+++` (Hugo-style). One designated field of the record holds
// the markdown body; on serialize, the body is optionally normalized via
// markdownlint --fix.
//
// **Trailing newline convention.** The on-disk file always ends with exactly
// one `\n` (per the spec). The body that round-trips through serialize/parse
// therefore *does not* carry a trailing newline — a `body` value of `'hi\n'`
// is normalized to `'hi'` on the way out. This matches how every UNIX text
// editor handles files: the final newline belongs to the file, not the
// content.
//
// See specs/behaviors/content-types.md.

import { lint } from 'markdownlint/promise';
import { applyFixes } from 'markdownlint';

import { parseToml, stringifyRecord } from '../toml.js';
import type { RecordLike } from '../path-template/index.js';
import type { Format, FormatConfig } from './index.js';

const DELIMITER = '+++';
const DELIMITER_LINE_RE = /^\+\+\+\s*$/m;

/**
 * Default markdownlint rules layered on top of any consumer config. MD013
 * (line-length) and MD041 (first-line H1) are off because content bodies
 * commonly have long lines and don't always lead with a heading.
 */
const DEFAULT_MARKDOWNLINT_CONFIG: Readonly<Record<string, unknown>> = {
  default: true,
  MD013: false,
  MD041: false,
};

function bodyFieldName(config: FormatConfig): string {
  if (!config.body) {
    throw new Error(
      `markdown format requires [gitsheet.format].body to be set to the field name holding the body text`,
    );
  }
  return config.body;
}

async function normalizeBody(
  body: string,
  config: FormatConfig,
): Promise<string> {
  if (config.markdownlint === false) return body;
  const userConfig = config.markdownlint ?? {};
  const merged = { ...DEFAULT_MARKDOWNLINT_CONFIG, ...userConfig };
  const result = await lint({
    strings: { record: body },
    // markdownlint's `Configuration` type is a structural shape — cast through
    // a record type rather than enumerating every rule.
    config: merged as { [key: string]: unknown },
  });
  const issues = result['record'] ?? [];
  if (issues.length === 0) return body;
  return applyFixes(body, issues);
}

export const markdownFormat: Format = {
  extension: '.md',

  async serialize(record: RecordLike, config: FormatConfig): Promise<string> {
    const bodyField = bodyFieldName(config);
    const bodyRaw = record[bodyField];
    if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
      throw new TypeError(
        `markdown format: record.${bodyField} must be a string, got ${typeof bodyRaw}`,
      );
    }
    const body = (bodyRaw as string | undefined) ?? '';

    // Split: frontmatter = everything except the body field.
    const frontmatter: RecordLike = {};
    for (const [k, v] of Object.entries(record)) {
      if (k === bodyField) continue;
      frontmatter[k] = v;
    }

    const fmText = stringifyRecord(frontmatter);
    const bodyText = await normalizeBody(body, config);

    // Layout: `+++\n<frontmatter>+++\n\n<body>\n`. stringifyRecord ends with
    // a newline already, so frontmatter slots in cleanly between delimiters.
    // The opening `+++` line gives editors a clear hint that frontmatter is
    // present (matches Hugo / Astro / Eleventy conventions).
    const trailingNewline = bodyText.endsWith('\n') ? '' : '\n';
    return `${DELIMITER}\n${fmText}${DELIMITER}\n\n${bodyText}${trailingNewline}`;
  },

  parse(text: string, config: FormatConfig): RecordLike {
    const bodyField = bodyFieldName(config);
    const { frontmatter, body } = splitOnDelimiters(text);
    const record = parseToml(frontmatter);
    record[bodyField] = body;
    return record;
  },

  parseHeaderOnly(text: string, config: FormatConfig): RecordLike {
    bodyFieldName(config); // validate config has body
    const { frontmatter } = splitOnDelimiters(text);
    return parseToml(frontmatter);
  },
};

/**
 * Split a markdown record's bytes into its frontmatter TOML and the body
 * text. The first matched `+++` line is the opener; the next `+++` line is
 * the closer. Anything before the opener (e.g., a UTF-8 BOM) is tolerated;
 * any subsequent `+++` line in the body is preserved verbatim.
 *
 * If the input lacks frontmatter delimiters entirely, returns an empty
 * frontmatter and the whole text as the body — that's a degenerate but
 * valid input (consumer gets `record.<bodyField> = text`, no fields set).
 */
function splitOnDelimiters(text: string): { frontmatter: string; body: string } {
  // Strip a UTF-8 BOM if present (some editors add one when saving as UTF-8).
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const openerMatch = DELIMITER_LINE_RE.exec(stripped);
  if (!openerMatch) {
    return { frontmatter: '', body: stripped };
  }
  const afterOpener = stripped.slice(openerMatch.index + openerMatch[0].length);
  // Drop the newline directly after the opener delimiter.
  const afterOpenerTrimmed = afterOpener.startsWith('\n')
    ? afterOpener.slice(1)
    : afterOpener;
  const closerMatch = DELIMITER_LINE_RE.exec(afterOpenerTrimmed);
  if (!closerMatch) {
    // Opener but no closer — malformed file. Treat everything after the
    // opener as body (matches what Hugo / Astro do for half-frontmatter).
    return { frontmatter: '', body: afterOpenerTrimmed };
  }
  const frontmatter = afterOpenerTrimmed.slice(0, closerMatch.index);
  // Drop the newline directly after the closer; trim leading blank line(s)
  // before the body content begins.
  let body = afterOpenerTrimmed.slice(closerMatch.index + closerMatch[0].length);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.startsWith('\n')) body = body.slice(1);
  // Drop a single trailing newline so a body that ends in `\n` round-trips
  // cleanly through the serializer (which always adds one).
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { frontmatter, body };
}
