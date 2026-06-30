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
