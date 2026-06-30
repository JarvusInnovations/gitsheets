// Working-tree adapter — the deep-path navigation layer over the holo-tree
// binding (#127).
//
// gitsheets used to thread hologit `TreeObject`/`BlobObject` handles (each a
// live subtree object) through `Repository` → `Transaction` → `Sheet` /
// `path-template`. The holo-tree binding instead exposes a single mutable root
// `Tree` whose every operation takes a **deep path** from the root. `TreeView`
// bridges the two: it wraps one binding `Tree` plus a `base` path, presenting
// the same `getChild` / `getChildren` / `getBlobMap` / `writeChild` /
// `deleteChild` / `clearChildren` / `getSubtree` / `getHash` / `clone` surface
// the consumers expect — but every call is `rootTree.op(join(base, rel))`, NOT
// a separate subtree handle. A "subtree" (`getSubtree` / a tree-typed
// `getChild`) is just another `TreeView` over the same root with a deeper base.
//
// `BlobHandle` is the gitsheets-owned public blob handle returned by
// `UpsertResult.blob`, `Sheet.getAttachment(s)`, and `Sheet.diffFrom`
// (`srcBlob`/`dstBlob`) — replacing hologit's `BlobObject` in the public API so
// the `hologit` dependency can be dropped without a runtime-visible change.
//
// See plans/holo-tree-migration.md and specs/rust-core.md.

import { execFile } from 'node:child_process';

import type {
  Repo as BindingRepo,
  Tree as BindingTree,
  ChildInfo,
  NamedChildInfo,
  BlobEntry,
} from '@hologit/holo-tree';

/** Git's canonical empty-tree hash. */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Join tree-path segments, dropping empties / `.` and stray slashes. */
export function joinTreePath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0 && p !== '.')
    .join('/');
}

/** Convert a git filemode number (e.g. `33188`) to its octal string (`100644`). */
function modeString(mode: number): string {
  return mode.toString(8).padStart(6, '0');
}

function catFileBlob(gitDir: string, hash: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['cat-file', 'blob', hash],
      { cwd: gitDir, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout as Buffer);
      },
    );
    child.stdin?.end();
  });
}

/**
 * gitsheets-owned public blob handle. Structurally compatible with how
 * consumers used hologit's `BlobObject`: `.hash`, `.mode`, `.isBlob === true`,
 * and `.read()` returning the blob bytes as a `Buffer`. Backing reads go
 * through `git cat-file blob <hash>` (or pre-captured bytes), so the handle
 * stays valid after the transaction commits.
 */
export interface BlobHandle {
  readonly isBlob: true;
  readonly hash: string;
  readonly mode: string;
  read(): Promise<Buffer>;
}

/**
 * Build a {@link BlobHandle} for a blob already in the ODB. `knownBytes`, when
 * supplied, short-circuits `read()` (avoids a `git cat-file` round-trip for a
 * blob whose bytes we just wrote).
 */
export function makeBlobHandle(
  gitDir: string,
  hash: string,
  mode = '100644',
  knownBytes?: Buffer,
): BlobHandle {
  return {
    isBlob: true,
    hash,
    mode,
    read: knownBytes !== undefined
      ? async (): Promise<Buffer> => knownBytes
      : (): Promise<Buffer> => catFileBlob(gitDir, hash),
  };
}

/**
 * Internal blob node yielded by tree navigation (`TreeView.getChild` /
 * `getChildren` / `getBlobMap`). `read()` returns UTF-8 *text* — the form
 * config and record readers want. Structurally a `PathTemplateBlob`.
 */
export interface BlobView {
  readonly isBlob: true;
  readonly hash: string;
  readonly mode: string;
  read(): Promise<string>;
}

/**
 * A deep-path view onto a single binding `Tree`, rooted at `base`. Navigation
 * never creates a binding-level subtree handle — `getSubtree` / a tree-typed
 * `getChild` just returns another `TreeView` over the same root with a deeper
 * base. All mutations flush lazily; `write()` / `getHash()` materialize.
 */
export class TreeView {
  readonly isTree = true;

  readonly #repo: BindingRepo;
  readonly #root: BindingTree;
  readonly #base: string;
  readonly #gitDir: string;

  constructor(repo: BindingRepo, root: BindingTree, base: string, gitDir: string) {
    this.#repo = repo;
    this.#root = root;
    this.#base = base.replace(/^\/+|\/+$/g, '');
    this.#gitDir = gitDir;
  }

  /** The underlying binding root tree — used by Transaction.finalize for `write()`. */
  get bindingTree(): BindingTree {
    return this.#root;
  }

  #full(path: string): string {
    return joinTreePath(this.#base, path);
  }

  /** Binding path argument: an empty path maps to `"."` (the whole tree). */
  #pathArg(full: string): string {
    return full === '' ? '.' : full;
  }

  #blobView(fullPath: string, hash: string, mode: number): BlobView {
    const root = this.#root;
    return {
      isBlob: true,
      hash,
      mode: modeString(mode),
      read: async (): Promise<string> => {
        const buf = root.readBlob(fullPath);
        if (buf === null) {
          throw new Error(`blob not found at ${fullPath}`);
        }
        return buf.toString('utf8');
      },
    };
  }

  async getChild(path: string): Promise<TreeView | BlobView | undefined> {
    const full = this.#full(path);
    const info: ChildInfo | null = this.#root.getChild(full);
    if (!info) return undefined;
    if (info.type === 'tree') {
      return new TreeView(this.#repo, this.#root, full, this.#gitDir);
    }
    return this.#blobView(full, info.hash, info.mode);
  }

  async getChildren(): Promise<Record<string, TreeView | BlobView>> {
    const out: Record<string, TreeView | BlobView> = {};
    const children: NamedChildInfo[] = this.#root.getChildren(this.#pathArg(this.#base));
    for (const c of children) {
      const full = joinTreePath(this.#base, c.name);
      out[c.name] = c.type === 'tree'
        ? new TreeView(this.#repo, this.#root, full, this.#gitDir)
        : this.#blobView(full, c.hash, c.mode);
    }
    return out;
  }

  async getBlobMap(): Promise<Record<string, BlobView>> {
    const out: Record<string, BlobView> = {};
    const entries: BlobEntry[] = this.#root.getBlobMap(this.#pathArg(this.#base));
    for (const e of entries) {
      out[e.path] = this.#blobView(joinTreePath(this.#base, e.path), e.hash, e.mode);
    }
    return out;
  }

  /**
   * Return a view rooted at `base/path`. With `create`, returns the view even
   * when nothing exists there yet (writes through it create intermediates);
   * otherwise returns `null` unless an actual tree lives at that path.
   */
  async getSubtree(path: string, create = false): Promise<TreeView | null> {
    const full = this.#full(path);
    if (!create) {
      const info = this.#root.getChild(full);
      if (!info || info.type !== 'tree') return null;
    }
    return new TreeView(this.#repo, this.#root, full, this.#gitDir);
  }

  async writeChild(path: string, content: string | BlobHandle): Promise<BlobHandle> {
    const full = this.#full(path);
    if (typeof content === 'string') {
      const hash = this.#root.writeChild(full, content);
      return makeBlobHandle(this.#gitDir, hash, '100644');
    }
    const bytes = await content.read();
    const hash = this.#root.writeChildBytes(full, bytes);
    return makeBlobHandle(this.#gitDir, hash, content.mode, bytes);
  }

  async writeChildBytes(path: string, content: Buffer): Promise<BlobHandle> {
    const hash = this.#root.writeChildBytes(this.#full(path), content);
    return makeBlobHandle(this.#gitDir, hash, '100644', content);
  }

  /** Delete a child at a deep path. Returns whether it existed. */
  async deleteChild(path: string): Promise<boolean> {
    return this.#root.deleteChildDeep(this.#full(path));
  }

  /** O(1) clear of this view's subtree (replace with the empty tree). */
  clearChildren(): void {
    this.#root.clearChildren(this.#pathArg(this.#base));
  }

  /** Flush dirty subtrees and return the resulting root tree hash. */
  async write(): Promise<string> {
    return this.#root.write();
  }

  /** Hash of the subtree at `base` (the whole tree when base is empty). */
  async getHash(): Promise<string> {
    const rootHash = this.#root.write();
    if (this.#base === '') return rootHash;
    const info = this.#root.getChild(this.#base);
    return info && info.type === 'tree' ? info.hash : EMPTY_TREE_HASH;
  }

  /**
   * Independent in-memory copy — flush to a hash, then reload a fresh tree
   * from it so mutations on the clone don't touch the original.
   */
  async clone(): Promise<TreeView> {
    const hash = this.#root.write();
    const fresh = this.#repo.createTreeFromRef(hash);
    return new TreeView(this.#repo, fresh, this.#base, this.#gitDir);
  }
}
