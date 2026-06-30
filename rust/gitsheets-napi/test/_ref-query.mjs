// Faithful JS reference for the query path — a transcription of the PRODUCTION
// query traversal + filter (`Template.queryTree` in
// `packages/gitsheets/src/path-template/index.ts` and `queryMatches` in
// `packages/gitsheets/src/sheet.ts`), kept standalone so the napi boundary
// suite stays independent of the main TS package.
//
// The Rust core's query (pruning walk + native filter, with the embedded boa
// engine for predicate snippets) is diffed against this. If the production
// query path changes, this copy must change in lockstep (it is the reference,
// not a second impl).

// ── parser (verbatim behavior from index.ts) ──────────────────────────────────

const FIELD_NAME_RE = /^[a-zA-Z0-9_-]+(\/\*\*)?$/;
const NOT_DEFINED_RE = / is not defined$/;

import { runInNewContext } from 'node:vm';

function compileExpression(source) {
  const compiled = runInNewContext(`(record) => { with (record) { return (${source}) } }`);
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
  return segments.map((parts) => {
    const onlyPart = parts.length === 1 ? parts[0] : null;
    const recursive = !!(onlyPart && onlyPart.kind === 'field' && onlyPart.recursive);
    return { parts, recursive };
  });
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

// ── FakeTree built from a flat {path: blobId} map ─────────────────────────────

class FakeBlob {
  constructor(id) {
    this.isBlob = true;
    this.id = id;
  }
}
class FakeTree {
  constructor() {
    this.isTree = true;
    this.children = {};
  }
  async getChild(name) {
    return this.children[name];
  }
  async getChildren() {
    return this.children;
  }
  async getBlobMap() {
    const out = {};
    const collect = (prefix, tree) => {
      for (const [name, child] of Object.entries(tree.children)) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (child instanceof FakeBlob) out[full] = child;
        else collect(full, child);
      }
    };
    collect('', this);
    return out;
  }
}

// Build a FakeTree from record paths (no extension) under base, each becoming a
// `<path>.toml` blob — exactly the on-disk shape `recordWrite` produces.
export function buildTree(recordPaths, extension = '.toml') {
  const root = new FakeTree();
  for (const rp of recordPaths) {
    const segs = `${rp}${extension}`.split('/');
    let cur = root;
    for (let k = 0; k < segs.length - 1; k++) {
      const s = segs[k];
      if (!(cur.children[s] instanceof FakeTree)) cur.children[s] = new FakeTree();
      cur = cur.children[s];
    }
    cur.children[segs[segs.length - 1]] = new FakeBlob(rp);
  }
  return root;
}

// ── queryTree (verbatim behavior from index.ts) ───────────────────────────────

function joinPath(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}
function isBlob(x) {
  return x && x.isBlob === true;
}
function isTree(x) {
  return x && x.isTree === true;
}

export async function* queryTree(components, tree, query, opts = {}) {
  if (!tree) return;
  const pathPrefix = opts.pathPrefix ?? '';
  const depth = opts.depth ?? 0;
  const extension = opts.extension ?? '.toml';
  const extLen = extension.length;
  const numComponents = components.length;
  let currentTree = tree;
  let currentPrefix = pathPrefix;

  for (let i = depth; i < numComponents; i++) {
    const isLast = i + 1 === numComponents;
    const c = components[i];
    const rendered = renderComponent(c, query);

    if (isLast) {
      if (rendered !== undefined) {
        const child = await currentTree.getChild(`${rendered}${extension}`);
        if (child && isBlob(child)) yield { path: joinPath(currentPrefix, rendered), blob: child };
        return;
      }
      const children = c.recursive ? await currentTree.getBlobMap() : await currentTree.getChildren();
      let attachmentPrefix;
      const allKeys = [];
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

    const children = await currentTree.getChildren();
    for (const name in children) {
      const child = children[name];
      if (!child || !isTree(child)) continue;
      yield* queryTree(components, child, query, {
        pathPrefix: joinPath(currentPrefix, name),
        depth: i + 1,
        extension,
      });
    }
    return;
  }
}

// ── queryMatches (verbatim from sheet.ts) ─────────────────────────────────────

export function queryMatches(filter, record) {
  for (const [key, qval] of Object.entries(filter)) {
    const rval = record[key];
    if (typeof qval === 'function') {
      if (!qval(rval, record)) return false;
      continue;
    }
    if (qval !== null && typeof qval === 'object' && !Array.isArray(qval) && !(qval instanceof Date)) {
      if (rval === null || typeof rval !== 'object') return false;
      if (!queryMatches(qval, rval)) return false;
      continue;
    }
    if (rval !== qval) return false;
  }
  return true;
}

// ── convenience: the full reference query over a {path: record} corpus ────────

// `query` is the prune query (path-template inputs only). `filter` is the full
// queryMatches filter (literals + predicate functions). Returns matched
// `{path, record}` sorted by path.
export async function refQuery(corpus, template, query, filter) {
  const components = parseTemplate(template);
  const byPath = new Map(corpus.map((e) => [e.path, e.record]));
  const tree = buildTree(corpus.map((e) => e.path));
  const out = [];
  for await (const { path } of queryTree(components, tree, query)) {
    const record = byPath.get(path);
    if (queryMatches(filter, record)) out.push({ path, record });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export async function refCandidates(corpus, template, query) {
  const components = parseTemplate(template);
  const tree = buildTree(corpus.map((e) => e.path));
  const paths = [];
  for await (const { path } of queryTree(components, tree, query)) paths.push(path);
  paths.sort();
  return paths;
}
