// Shared helpers for the `contracts` command group (list/verify/test). Every
// primitive here is built from the SAME public `gitsheets` surface the rest
// of gitsheets-axi already consumes (`Repository.readBlobStream`,
// `parseConfigToml`/`parseToml`) — none of this reaches into
// `gitsheets`'s internal `cli/contracts.ts` (not part of the package's public
// export map; see `packages/gitsheets/package.json`'s `exports`). The actual
// JSON-Schema validation is always delegated to the public `validateRecord`
// (see commands/contracts.ts) — nothing here re-implements schema checking.
//
// See specs/behaviors/contracts.md for the vocabulary (vendored contract,
// `implements`, the derived path formula) this module mechanically applies.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { canonicalContractHash, parseConfigToml, parseToml, type Repository } from 'gitsheets';

const exec = promisify(execFile);

/** Root of the vendored contract store, relative to the repo root. */
export const CONTRACTS_ROOT = '.gitsheets/contracts';

/**
 * The derived vendored path for a contract name — a mechanical formula
 * (specs/behaviors/contracts.md "Contract names and the derived path"), not a
 * core lookup: `.gitsheets/contracts/<name>.toml`.
 */
export function contractPathFor(name: string): string {
  return `${CONTRACTS_ROOT}/${name}.toml`;
}

/** Drain a Node Readable (as returned by `Repository.readBlobStream`) to a UTF-8 string. */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Read a vendored contract's raw canonical-TOML text by name. Throws NotFoundError if unvendored. */
export async function readVendoredContractText(
  repo: Repository,
  treeRef: string,
  name: string,
): Promise<string> {
  return streamToString(await repo.readBlobStream(treeRef, contractPathFor(name)));
}

/**
 * Every vendored contract name under `.gitsheets/contracts/` at `treeRef`.
 * The `sources.toml` sidecar is excluded — contract names always contain a
 * `/` (host-qualified), so a top-level file can never collide with one (see
 * specs/behaviors/contracts.md "Contract names and the derived path").
 *
 * No public `Repository` API lists tree contents, so this shells out to
 * `git ls-tree` against `repo.gitDir` — the same plumbing
 * `Repository.readBlobStream` itself uses internally for blob reads.
 */
export async function listVendoredContractNames(
  repo: Repository,
  treeRef: string,
): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'git',
      ['ls-tree', '-r', '--name-only', treeRef, '--', CONTRACTS_ROOT],
      { cwd: repo.gitDir },
    ));
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const p = line.trim();
    if (!p || !p.startsWith(`${CONTRACTS_ROOT}/`) || !p.endsWith('.toml')) continue;
    const rel = p.slice(CONTRACTS_ROOT.length + 1, -'.toml'.length);
    if (!rel.includes('/')) continue; // top-level file (sources.toml) — never a contract name
    names.push(rel);
  }
  return names.sort();
}

/**
 * The `implements` array declared by `.gitsheets/<sheet>.toml` at `treeRef`
 * ([] if the config is absent/unparseable/has no such key) — parsed with the
 * same public `parseConfigToml` the library's own config loader uses
 * (`Sheet`'s `SheetConfig` just doesn't surface this one field).
 */
export async function readSheetImplements(
  repo: Repository,
  treeRef: string,
  sheetName: string,
): Promise<string[]> {
  const configPath = `.gitsheets/${sheetName}.toml`;
  let text: string;
  try {
    text = await streamToString(await repo.readBlobStream(treeRef, configPath));
  } catch {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfigToml(text, configPath) as Record<string, unknown>;
  } catch {
    return [];
  }
  const gitsheet = parsed['gitsheet'] as Record<string, unknown> | undefined;
  const raw = gitsheet?.['implements'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

/**
 * Best-effort check that an already-vendored contract's raw bytes still
 * satisfy the two cheapest "document requirements" (specs/behaviors/
 * contracts.md "Contract document requirements" #1 canonical form, #5 `$id`
 * matches the derived path) — a non-empty result is a `contract_invalid`-
 * grade problem. Returns the violation messages (empty = no problem found).
 *
 * This is deliberately NOT the core's full `load_contract`/
 * `check_contract_document` gate — the other three requirements
 * (self-contained/no external `$ref`, open-for-extension/no closed
 * `additionalProperties`, no null-bearing keywords) are enforced by the core
 * at sheet-open for a *write* path (`Sheet::open` → `compile_effective_schema`
 * → `load_contract`), which no read-only public API reaches independent of an
 * actual write. Built from the same public `canonicalContractHash` identity
 * primitive `contracts list` uses — no JSON-Schema validation is
 * re-implemented here, only a byte-identity + string comparison.
 */
export function checkVendoredContractIdentity(name: string, text: string): string[] {
  const problems: string[] = [];

  const rawHash = createHash('sha256').update(text, 'utf-8').digest('hex');
  let canonicalHash: string;
  try {
    canonicalHash = canonicalContractHash(text, { format: 'toml' });
  } catch (error) {
    return [`failed to canonicalize: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (rawHash !== canonicalHash) {
    problems.push('vendored bytes are not canonical TOML — re-encoding produces different bytes');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    problems.push(`failed to parse: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }
  const expectedId = `https://${name}`;
  if (parsed['$id'] !== expectedId) {
    problems.push(
      `$id ${JSON.stringify(parsed['$id'] ?? null)} does not match the derived path (expected ${JSON.stringify(expectedId)})`,
    );
  }

  return problems;
}

/**
 * Advisory-only structural check (specs/behaviors/contracts.md "Composition
 * and enforcement" — the closed-local-schema footgun): does `schema` (or any
 * nested subschema) set `additionalProperties: false`? Pure data-shape
 * recursion, not JSON-Schema validation — safe to compute locally.
 */
export function hasClosedAdditionalProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasClosedAdditionalProperties);
  if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'additionalProperties' && value === false) return true;
      if (hasClosedAdditionalProperties(value)) return true;
    }
  }
  return false;
}

/** Join a list of names for a TOON cell, with a fallback for the empty case. */
export function joinNamesOr(names: readonly string[], fallback = '(none)'): string {
  return names.length > 0 ? names.join('|') : fallback;
}
