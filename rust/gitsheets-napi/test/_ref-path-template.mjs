// Faithful JS reference renderer — a transcription of the PRODUCTION path
// renderer (`packages/gitsheets/src/path-template/index.ts`), kept standalone so
// the napi boundary suite stays independent of the main TS package.
//
// The point of the transcription: expression components evaluate through
// `node:vm` (`runInNewContext`) exactly as production does. That is the
// `node:vm` baseline the embedded boa engine is diffed against in
// `path-template.mjs`. The parser, `stringifyValue`, and invalid-char rules are
// copied verbatim in behavior from index.ts. If the production renderer changes,
// this copy must change in lockstep (it is the reference, not a second impl).

import { runInNewContext } from 'node:vm';

const WINDOWS_INVALID = /[<>:"|?*\x00-\x1f]/;
const SEGMENT_INVALID = /[<>:"|?*\x00-\x1f/]/;
const FIELD_NAME_RE = /^[a-zA-Z0-9_-]+(\/\*\*)?$/;
const NOT_DEFINED_RE = / is not defined$/;

class RefPathError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function compileExpression(source) {
  let compiled;
  try {
    compiled = runInNewContext(`(record) => { with (record) { return (${source}) } }`);
  } catch (err) {
    throw new RefPathError('path_render_failed', `expression failed to compile: ${err.message}`);
  }
  return (record) => {
    try {
      return compiled(record);
    } catch (err) {
      if (err instanceof ReferenceError && NOT_DEFINED_RE.test(err.message)) return undefined;
      throw err;
    }
  };
}

function stringifyValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'function') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toString();
  return undefined;
}

// --- Date buckets (transcribed from the production renderer; spec:
// specs/behaviors/path-templates.md § "Date-bucket references") ---

const BUCKET_FORMATS = {
  'YYYY': ['YYYY'],
  'YYYY/MM': ['YYYY', 'MM'],
  'YYYY/MM/DD': ['YYYY', 'MM', 'DD'],
  'YYYY/WW': ['isoYYYY', 'WW'],
};

const BUCKET_FIELD_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function splitBucketAttempt(source) {
  const idx = source.indexOf(':');
  if (idx === -1) return undefined;
  const head = source.slice(0, idx).trim();
  if (head === '') return undefined;
  const field = head.split('.');
  if (!field.every((seg) => BUCKET_FIELD_SEGMENT_RE.test(seg))) return undefined;
  return { field, format: source.slice(idx + 1).trim() };
}

const BUCKET_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUCKET_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

function isRealDate(year, month, day) {
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

// Strict-only (refRender renders full records): wrong type / unparseable
// throws; absent field returns undefined (un-renderable).
function bucketDate(record, field) {
  let current = record;
  for (const seg of field) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = current[seg];
    if (current === undefined) return undefined;
  }
  const name = field.join('.');
  const fail = (detail) => {
    throw new RefPathError('path_render_failed', `date-bucket reference: ${detail}`);
  };
  if (current instanceof Date) {
    if (Number.isNaN(current.getTime())) fail(`field "${name}" is an invalid Date`);
    return { year: current.getUTCFullYear(), month: current.getUTCMonth() + 1, day: current.getUTCDate() };
  }
  if (typeof current === 'string') {
    const dateOnly = BUCKET_DATE_ONLY_RE.exec(current);
    if (dateOnly) {
      const [, y, m, d] = dateOnly;
      const year = Number(y), month = Number(m), day = Number(d);
      if (!isRealDate(year, month, day)) fail(`field "${name}" value ${JSON.stringify(current)} is not a real date`);
      return { year, month, day };
    }
    const dt = BUCKET_DATETIME_RE.exec(current);
    if (dt) {
      const [, y, m, d, hh, mm, ss, offset] = dt;
      const year = Number(y), month = Number(m), day = Number(d);
      if (!isRealDate(year, month, day) || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 60) {
        fail(`field "${name}" value ${JSON.stringify(current)} is not a real date or time`);
      }
      if (offset === undefined) return { year, month, day };
      const epoch = Date.parse(current);
      if (Number.isNaN(epoch)) fail(`field "${name}" value ${JSON.stringify(current)} is not parseable`);
      const at = new Date(epoch);
      return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
    }
    fail(`field "${name}" value ${JSON.stringify(current)} is not an ISO 8601 date or datetime`);
  }
  fail(`field "${name}" has type ${Array.isArray(current) ? 'array' : typeof current}`);
}

function isoWeekOf(d) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const isoYear = t.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((t.getTime() - jan1) / 86_400_000 / 7) + 1;
  return { year: isoYear, week };
}

const pad2 = (n) => String(n).padStart(2, '0');
const pad4 = (n) => String(n).padStart(4, '0');

function renderBucketUnit(date, unit) {
  switch (unit) {
    case 'YYYY': return pad4(date.year);
    case 'MM': return pad2(date.month);
    case 'DD': return pad2(date.day);
    case 'isoYYYY': return pad4(isoWeekOf(date).year);
    case 'WW': return pad2(isoWeekOf(date).week);
  }
}

function parseTemplate(source) {
  const normalized = source.replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized === '') throw new RefPathError('path_render_failed', 'path template is empty');

  const segments = [[]];
  let pendingLiteral = '';
  let i = 0;
  const flushLiteral = () => {
    if (pendingLiteral) {
      segments[segments.length - 1].push({ kind: 'literal', text: pendingLiteral });
      pendingLiteral = '';
    }
  };

  while (i < normalized.length) {
    if (normalized.startsWith('${{', i)) {
      flushLiteral();
      i += 3;
      let exprSource = '';
      while (!normalized.startsWith('}}', i)) {
        if (i >= normalized.length) throw new RefPathError('path_render_failed', 'unclosed expression');
        exprSource += normalized[i];
        i++;
      }
      exprSource = exprSource.trim();
      i += 2;
      const bucket = splitBucketAttempt(exprSource);
      if (bucket !== undefined) {
        const units = BUCKET_FORMATS[bucket.format];
        if (units === undefined) {
          throw new RefPathError('config_invalid', `invalid date-bucket format ${JSON.stringify(bucket.format)}`);
        }
        const standaloneBefore = segments[segments.length - 1].length === 0;
        const standaloneAfter = i >= normalized.length || normalized[i] === '/';
        if (!standaloneBefore || !standaloneAfter) {
          throw new RefPathError('config_invalid', 'date-bucket reference must stand alone in its path segment');
        }
        for (let u = 0; u < units.length; u++) {
          if (u > 0) segments.push([]);
          segments[segments.length - 1].push({ kind: 'bucket', field: bucket.field, unit: units[u] });
        }
        continue;
      }
      if (FIELD_NAME_RE.test(exprSource)) {
        const recursive = exprSource.endsWith('/**');
        const name = recursive ? exprSource.slice(0, -3) : exprSource;
        segments[segments.length - 1].push({ kind: 'field', name, recursive });
      } else {
        segments[segments.length - 1].push({
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
      pendingLiteral += normalized[i];
      i++;
    }
  }
  flushLiteral();

  const components = segments.map((parts, idx) => {
    if (parts.length === 0) throw new RefPathError('path_render_failed', `empty component ${idx}`);
    const onlyPart = parts.length === 1 ? parts[0] : null;
    const recursive = onlyPart && onlyPart.kind === 'field' && onlyPart.recursive;
    if (!recursive) {
      for (const part of parts) {
        if (part.kind === 'field' && part.recursive) {
          throw new RefPathError('path_render_failed', 'recursive field must be sole part');
        }
      }
    }
    return { parts, recursive };
  });

  for (let k = 0; k < components.length - 1; k++) {
    if (components[k].recursive) throw new RefPathError('path_render_failed', 'recursive must be last');
  }
  return components;
}

function renderPart(part, record) {
  switch (part.kind) {
    case 'literal':
      return part.text;
    case 'field':
      return stringifyValue(record[part.name]);
    case 'bucket': {
      const date = bucketDate(record, part.field);
      return date === undefined ? undefined : renderBucketUnit(date, part.unit);
    }
    case 'expression':
      return stringifyValue(part.evaluate(record));
  }
}

function renderComponent(c, record) {
  let out = '';
  for (const part of c.parts) {
    const piece = renderPart(part, record);
    if (piece === undefined) return undefined;
    out += piece;
  }
  return out;
}

// Render a template against a record, mirroring Template.render. Throws
// RefPathError with `.code` of 'path_render_failed' / 'path_invalid_chars'.
export function refRender(templateString, record) {
  const components = parseTemplate(templateString);
  const segments = [];
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const rendered = renderComponent(c, record);
    if (rendered === undefined) {
      throw new RefPathError('path_render_failed', `cannot render component ${i}`);
    }
    const pattern = c.recursive ? WINDOWS_INVALID : SEGMENT_INVALID;
    if (pattern.test(rendered)) {
      throw new RefPathError('path_invalid_chars', `component ${i} has invalid char`);
    }
    segments.push(rendered);
  }
  return segments.join('/');
}
