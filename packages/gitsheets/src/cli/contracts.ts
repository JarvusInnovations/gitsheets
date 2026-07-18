// `git sheet contracts <subcommand>` — adopt, verify, test, sync, export,
// prune. See specs/api/cli.md ("git sheet contracts <subcommand>") and
// specs/behaviors/contracts.md.
//
// Every command here is a thin CLI orchestration layer over the primitives
// `gitsheets-core::contract` already provides (name validation, the derived
// vendored path, the document-requirement walk, and the vendored-tree
// loader — each surfaced as a minimal napi wrapper: `validateContractName`,
// `contractPath`, `checkContractDocument`, `contractLoad`). The one thing
// assembled host-side is the "effective schema" `allOf` array — a documented,
// mechanical formula (specs/behaviors/contracts.md "Composition and
// enforcement"), not a re-implementation of any core logic — which is then
// validated through the existing `addon.validateBatch`, exactly as
// `[gitsheet.schema]` alone already is elsewhere in this CLI.
//
// All writes these commands make are confined to `.gitsheets/contracts/` —
// sheet configs are never rewritten by tooling (see `printImplementsHint`).

import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

import type { Argv } from 'yargs';

import { addon, callCore } from '../core.js';
import { ConfigError, ContractError } from '../errors.js';
import type { ValidationIssue } from '../errors.js';
import { openRepo } from '../repository.js';
import type { RecordLike } from '../path-template/index.js';
import { parseToml, stringifyRecord } from '../toml.js';
import type { JSONSchema } from '../validation.js';
import { buildTxOpts, type GlobalArgs } from './shared.js';

const exec = promisify(execFile);

const RECORD_PATH_SYMBOL = Symbol.for('gitsheets-path');

// --- Shared arg shape ---------------------------------------------------------

type ContractsArgs = GlobalArgs;

interface AdoptArgs extends ContractsArgs {
  source: string;
  sheet?: string[];
}

interface VerifyArgs extends ContractsArgs {
  sheets?: string[];
}

interface TestArgs extends ContractsArgs {
  sheet: string;
  against: string;
}

interface SyncArgs extends ContractsArgs {
  names?: string[];
}

interface ExportArgs extends ContractsArgs {
  name: string;
}

interface PruneArgs extends ContractsArgs {
  dryRun?: boolean;
  yes?: boolean;
}

// --- Path helpers --------------------------------------------------------------

/** Prefix `relPath` with `root` when `root` isn't the repo root. */
function scopedPath(root: string, relPath: string): string {
  const cleanRoot = root.replace(/^\/+|\/+$/g, '');
  if (!cleanRoot || cleanRoot === '.') return relPath;
  return `${cleanRoot}/${relPath}`;
}

function sheetOpenOpts(root: string): { root?: string } {
  return root && root !== '.' && root !== '/' ? { root } : {};
}

/** `git cat-file blob <ref>:<path>` — null when the path doesn't exist at `ref`. */
async function readBlobText(gitDir: string, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['cat-file', 'blob', `${ref}:${path}`], {
      cwd: gitDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** The `implements` array declared by `<root>/.gitsheets/<sheet>.toml` at `ref` ([] if absent/unparseable). */
async function readImplements(
  gitDir: string,
  ref: string,
  root: string,
  sheet: string,
): Promise<string[]> {
  const configPath = scopedPath(root, `.gitsheets/${sheet}.toml`);
  const text = await readBlobText(gitDir, ref, configPath);
  if (text === null) return [];
  let parsed: RecordLike;
  try {
    parsed = parseToml(text) as RecordLike;
  } catch {
    return [];
  }
  const gitsheet = (parsed['gitsheet'] as RecordLike) ?? {};
  const raw = gitsheet['implements'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

function recordPathOf(record: RecordLike): string | undefined {
  const p = (record as Record<symbol, unknown>)[RECORD_PATH_SYMBOL];
  return typeof p === 'string' ? p : undefined;
}

// --- Document I/O + parsing ----------------------------------------------------

type DocFormat = 'json' | 'toml';

function sniffFormat(text: string): DocFormat {
  return text.trimStart().startsWith('{') ? 'json' : 'toml';
}

function formatFromExtension(path: string): DocFormat | undefined {
  if (path.endsWith('.toml')) return 'toml';
  if (path.endsWith('.json')) return 'json';
  return undefined;
}

/** Read `source` — an `https://` URL (one-shot fetch, 15s timeout), a local file path, or `-` for stdin. */
async function readSource(source: string): Promise<{ text: string; format: DocFormat }> {
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { text, format: sniffFormat(text) };
  }
  if (/^https:\/\//i.test(source)) {
    let res: Response;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new ConfigError(
        'config_invalid',
        `contracts: could not fetch ${source}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new ConfigError(
        'config_invalid',
        `contracts: fetch ${source} failed: ${res.status} ${res.statusText}`,
      );
    }
    const text = await res.text();
    return { text, format: formatFromExtension(source) ?? sniffFormat(text) };
  }
  const text = await readFile(source, 'utf8');
  return { text, format: formatFromExtension(source) ?? sniffFormat(text) };
}

function parseDocument(text: string, format: DocFormat): RecordLike {
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(
        'config_invalid',
        `contracts: failed to parse document as JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError('config_invalid', 'contracts: document must be a JSON/TOML table');
    }
    return parsed as RecordLike;
  }
  try {
    return parseToml(text);
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `contracts: failed to parse document as TOML: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Load a vendored contract's JSON via the core's `load_contract` (byte-canonical + document-requirement + $id↔path checks, all enforced there). */
function loadVendoredContract(
  gitDir: string,
  ref: string,
  root: string,
  name: string,
): JSONSchema {
  const text = callCore(() => addon.contractLoad(gitDir, ref, root, name));
  return JSON.parse(text) as JSONSchema;
}

/** Resolve `<file-or-name>` per `contracts test --against`: an existing file path, else a vendored contract name. */
async function resolveAgainstSchema(
  gitDir: string,
  ref: string,
  root: string,
  against: string,
): Promise<JSONSchema> {
  let isFile = false;
  try {
    isFile = (await stat(against)).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    const text = await readFile(against, 'utf8');
    const format = formatFromExtension(against) ?? sniffFormat(text);
    return parseDocument(text, format) as JSONSchema;
  }
  return loadVendoredContract(gitDir, ref, root, against);
}

/** Recursively scan a JSON Schema object for `additionalProperties: false` at any depth (advisory only — see `contracts verify`'s closed-local-schema warning). */
function schemaHasClosedAdditionalProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaHasClosedAdditionalProperties);
  if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as RecordLike)) {
      if (key === 'additionalProperties' && value === false) return true;
      if (schemaHasClosedAdditionalProperties(value)) return true;
    }
  }
  return false;
}

/** Validate `records` against `schema`, streaming per-record issues to stderr under `label`. Returns whether any record failed. */
function streamValidateBatch(
  schema: JSONSchema,
  records: RecordLike[],
  label: (record: RecordLike, index: number) => string,
  prefix: string,
): boolean {
  if (records.length === 0) return false;
  const issuesPerRecord = callCore(() => addon.validateBatch(schema, records)) as ValidationIssue[][];
  let anyFailed = false;
  issuesPerRecord.forEach((issues, i) => {
    if (issues.length === 0) return;
    anyFailed = true;
    for (const issue of issues) {
      process.stderr.write(
        `gitsheets: ${prefix}: ${label(records[i]!, i)}: ${issue.path.join('.') || '<root>'}: ` +
          `${issue.message}${issue.contract ? ` [${issue.contract}]` : ''}\n`,
      );
    }
  });
  return anyFailed;
}

function printImplementsHint(name: string): void {
  process.stdout.write(
    `add to the declaring sheet's config (tooling never edits sheet configs):\n` +
      `  implements = ['${name}']\n`,
  );
}

// --- adopt ----------------------------------------------------------------------

async function runContractsAdopt(argv: AdoptArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  // yargs-parser mangles a bare `-` positional into `''` (the same quirk
  // `upsert`'s `[input]` sidesteps by also accepting `undefined`) — normalize
  // both back to the `-` stdin sentinel `readSource`/the sources.toml
  // provenance logic below actually check for.
  const source = argv.source === '' ? '-' : argv.source;
  const { text, format } = await readSource(source);
  const document = parseDocument(text, format);

  const id = document['$id'];
  if (typeof id !== 'string' || !id.startsWith('https://')) {
    throw new ConfigError(
      'config_invalid',
      "contracts adopt: document is missing a required $id ('https://<host-qualified-name>')",
    );
  }
  const name = id.slice('https://'.length);
  callCore(() => addon.validateContractName(name));
  // Check the document requirements against the ORIGINAL source text (not the
  // already-parsed `document`) — a JSON-sourced candidate's literal `null`
  // (the thing requirement 4 exists to catch) would otherwise be silently
  // dropped by the JsValue marshalling boundary before ever reaching the
  // check. See `checkContractDocument`'s doc comment in gitsheets-napi.
  callCore(() => addon.checkContractDocument(name, text, format));

  // Canonicalize through the SAME encoder vendored contracts (and records)
  // are byte-authoritative through — the written file is canonical by
  // construction (specs/behaviors/contracts.md "Canonical form").
  const canonicalText = stringifyRecord(document);
  const vendorPath = scopedPath(root, addon.contractPath(name));

  // Adoption gate: with --sheet, validate EVERY existing record of each named
  // sheet against the would-be effective schema (its currently-declared
  // contracts + this candidate + its local schema). Any failure refuses the
  // whole adopt — nothing is written (specs/behaviors/contracts.md
  // "Adoption is gated on existing data").
  if (argv.sheet && argv.sheet.length > 0) {
    let anyFailed = false;
    for (const sheetName of argv.sheet) {
      const sheet = await repo.openSheet(sheetName, sheetOpenOpts(root));
      const config = await sheet.readConfig();
      const existingNames = await readImplements(repo.gitDir, ref, root, sheetName);
      const contractSchemas = existingNames.map((n) => loadVendoredContract(repo.gitDir, ref, root, n));
      contractSchemas.push(document as JSONSchema);
      const effectiveSchema: JSONSchema = { allOf: [...contractSchemas, config.schema ?? {}] };

      const records: RecordLike[] = [];
      for await (const r of sheet.query()) records.push(r);
      const failed = streamValidateBatch(
        effectiveSchema,
        records,
        (r, i) => `${sheetName} ${recordPathOf(r) ?? `#${i}`}`,
        'contracts adopt',
      );
      if (failed) anyFailed = true;
    }
    if (anyFailed) {
      throw new ContractError(
        'contract_unsatisfied',
        `contracts adopt: ${name} refused — existing records of one or more named sheets do not ` +
          'conform to the new effective schema; the tree was left untouched',
      );
    }
  }

  // All gates passed — vendor the document + record provenance atomically.
  const sourcesPath = scopedPath(root, '.gitsheets/contracts/sources.toml');
  const existingSourcesText = await readBlobText(repo.gitDir, ref, sourcesPath);
  let sources: RecordLike = {};
  if (existingSourcesText !== null) {
    try {
      sources = parseToml(existingSourcesText) as RecordLike;
    } catch {
      sources = {};
    }
  }
  // sources.toml is non-load-bearing provenance (specs/behaviors/contracts.md
  // "The sources sidecar") — a stdin ('-') adopt has no meaningful source to
  // record, so it's simply omitted (an absent entry is documented as
  // no-loss-of-function). Union merge: each contract name is its own table,
  // so two branches adopting different contracts never conflict.
  if (source !== '-') {
    sources = { ...sources, [name]: { source, adopted: new Date() } };
  }
  const sourcesText = stringifyRecord(sources);

  const txOpts = buildTxOpts(argv, `contracts adopt ${name}`);
  await repo.transact(txOpts, async (tx) => {
    tx.writeFile(vendorPath, canonicalText);
    if (source !== '-') {
      tx.writeFile(sourcesPath, sourcesText);
    }
  });

  process.stdout.write(`adopted ${name} → ${vendorPath}\n`);
  printImplementsHint(name);
}

// --- verify -----------------------------------------------------------------

async function runContractsVerify(argv: VerifyArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  let sheetNames: string[];
  if (argv.sheets && argv.sheets.length > 0) {
    sheetNames = argv.sheets;
  } else {
    sheetNames = Object.keys(await repo.openSheets(sheetOpenOpts(root)));
  }

  let hardFailure = false;
  let checkedAny = false;

  for (const sheetName of sheetNames) {
    const implementsNames = await readImplements(repo.gitDir, ref, root, sheetName);
    if (implementsNames.length === 0) continue;
    checkedAny = true;

    const sheet = await repo.openSheet(sheetName, sheetOpenOpts(root));
    const config = await sheet.readConfig();

    // 1) every declared name resolves + document requirements + canonical +
    // $id↔path — all enforced inside `load_contract` itself.
    const contractSchemas: JSONSchema[] = [];
    let loadFailed = false;
    for (const contractName of implementsNames) {
      try {
        contractSchemas.push(loadVendoredContract(repo.gitDir, ref, root, contractName));
      } catch (err) {
        hardFailure = true;
        loadFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`gitsheets: contracts verify: ${sheetName} implements ${contractName}: ${message}\n`);
      }
    }
    if (loadFailed) continue;

    // 2) every record validates against the effective schema.
    const effectiveSchema: JSONSchema = { allOf: [...contractSchemas, config.schema ?? {}] };
    const records: RecordLike[] = [];
    for await (const r of sheet.query()) records.push(r);
    const failed = streamValidateBatch(
      effectiveSchema,
      records,
      (r, i) => `${sheetName} ${recordPathOf(r) ?? `#${i}`}`,
      'contracts verify',
    );
    if (failed) hardFailure = true;

    // 3) advisory: a closed local schema can silently reject conforming
    // contract data under allOf composition — warn, never fail.
    if (config.schema && schemaHasClosedAdditionalProperties(config.schema)) {
      process.stderr.write(
        `gitsheets: contracts verify: warning — ${sheetName}'s local [gitsheet.schema] sets ` +
          'additionalProperties: false, which can reject contract-conforming records under allOf composition\n',
      );
    }
  }

  if (hardFailure) {
    throw new ContractError(
      'contract_unsatisfied',
      'contracts verify: one or more sheets failed contract verification',
    );
  }
  process.stdout.write(
    checkedAny ? 'contracts verify: ok\n' : 'contracts verify: no sheets declare any contracts\n',
  );
}

// --- test -----------------------------------------------------------------------

async function runContractsTest(argv: TestArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  const sheet = await repo.openSheet(argv.sheet, sheetOpenOpts(root));
  const targetSchema = await resolveAgainstSchema(repo.gitDir, ref, root, argv.against);

  const records: RecordLike[] = [];
  for await (const r of sheet.query()) records.push(r);

  if (records.length === 0) {
    process.stdout.write(`contracts test: ${argv.sheet} has no records — trivially conforms\n`);
    return;
  }

  const issuesPerRecord = callCore(() => addon.validateBatch(targetSchema, records)) as ValidationIssue[][];
  let failed = false;
  issuesPerRecord.forEach((issues, i) => {
    const label = recordPathOf(records[i]!) ?? `#${i}`;
    if (issues.length === 0) {
      process.stdout.write(`ok ${label}\n`);
      return;
    }
    failed = true;
    for (const issue of issues) {
      process.stderr.write(
        `gitsheets: contracts test: ${label}: ${issue.path.join('.') || '<root>'}: ${issue.message}\n`,
      );
    }
  });

  if (failed) {
    throw new ContractError(
      'contract_unsatisfied',
      `contracts test: ${argv.sheet} does not conform to ${argv.against}`,
    );
  }
}

// --- sync -----------------------------------------------------------------------

async function runContractsSync(argv: SyncArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  const sourcesPath = scopedPath(root, '.gitsheets/contracts/sources.toml');
  const sourcesText = await readBlobText(repo.gitDir, ref, sourcesPath);
  const sources: RecordLike = sourcesText !== null ? (parseToml(sourcesText) as RecordLike) : {};

  const names = argv.names && argv.names.length > 0 ? argv.names : Object.keys(sources);

  for (const name of names) {
    const entry = sources[name] as RecordLike | undefined;
    const source = entry && typeof entry['source'] === 'string' ? (entry['source'] as string) : undefined;
    if (!source) {
      process.stdout.write(`unsyncable ${name} (no recorded source)\n`);
      continue;
    }

    const vendorPath = scopedPath(root, addon.contractPath(name));
    const vendoredText = await readBlobText(repo.gitDir, ref, vendorPath);
    if (vendoredText === null) {
      process.stdout.write(`missing ${name}: recorded source but no vendored document at ${vendorPath}\n`);
      continue;
    }

    let fetched: { text: string; format: DocFormat };
    try {
      fetched = await readSource(source);
    } catch (err) {
      process.stdout.write(
        `error ${name}: could not re-fetch ${source}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const upstreamCanonical = stringifyRecord(parseDocument(fetched.text, fetched.format));

    // Never rewrites the vendored copy — published versions are immutable
    // (specs/behaviors/contracts.md "sync"); drift is reported, not pulled.
    if (upstreamCanonical === vendoredText) {
      process.stdout.write(`match ${name}\n`);
    } else {
      process.stdout.write(`drift ${name}: upstream ${source} differs from the vendored bytes (vendored copy not modified)\n`);
    }
  }
}

// --- export ---------------------------------------------------------------------

async function runContractsExport(argv: ExportArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  const schema = loadVendoredContract(repo.gitDir, ref, root, argv.name);
  process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
}

// --- prune ----------------------------------------------------------------------

/** Every vendored contract NAME under `<root>/.gitsheets/contracts/` at `ref` (the `sources.toml` sidecar is excluded — it never has a `/`, contract names always do). */
async function listVendoredContracts(gitDir: string, ref: string, root: string): Promise<string[]> {
  const base = scopedPath(root, '.gitsheets/contracts');
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['ls-tree', '-r', '--name-only', ref, '--', base], { cwd: gitDir }));
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const p = line.trim();
    if (!p || !p.startsWith(`${base}/`)) continue;
    const rel = p.slice(base.length + 1);
    if (!rel.endsWith('.toml')) continue;
    const name = rel.slice(0, -'.toml'.length);
    if (!name.includes('/')) continue; // top-level (sources.toml) — never a contract name
    names.push(name);
  }
  return names;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function runContractsPrune(argv: PruneArgs): Promise<void> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const ref = argv.ref ?? 'HEAD';
  const root = argv.root ?? '.';

  const allSheets = await repo.openSheets(sheetOpenOpts(root));
  const declared = new Set<string>();
  for (const sheetName of Object.keys(allSheets)) {
    for (const name of await readImplements(repo.gitDir, ref, root, sheetName)) {
      declared.add(name);
    }
  }

  const vendored = await listVendoredContracts(repo.gitDir, ref, root);
  const orphans = vendored.filter((name) => !declared.has(name));

  if (orphans.length === 0) {
    process.stdout.write('contracts prune: nothing to prune\n');
    return;
  }

  for (const name of orphans) {
    process.stdout.write(`${argv.dryRun ? 'would remove' : 'remove'} ${name}\n`);
  }
  if (argv.dryRun) return;

  if (!argv.yes) {
    const confirmed = await promptYesNo(
      `Remove ${orphans.length} vendored contract document(s) not declared by any sheet? [y/N] `,
    );
    if (!confirmed) {
      process.stdout.write('contracts prune: aborted\n');
      return;
    }
  }

  const txOpts = buildTxOpts(argv, `contracts prune (${orphans.length})`);
  await repo.transact(txOpts, async (tx) => {
    for (const name of orphans) {
      tx.deleteFile(scopedPath(root, addon.contractPath(name)));
    }
  });
  process.stdout.write(`removed ${orphans.length} vendored contract document(s)\n`);
}

// --- yargs wiring -----------------------------------------------------------------

export function registerContractsCommands(y: Argv): Argv {
  return y
    .command<AdoptArgs>(
      'adopt <source>',
      'Fetch/read a contract document (local path, https:// URL, or - for stdin; JSON or TOML), vendor it, and record provenance',
      (yy) =>
        yy
          .positional('source', { type: 'string', demandOption: true })
          .option('sheet', {
            type: 'string',
            array: true,
            describe:
              'Validate every existing record of this sheet against the would-be effective schema; refuse adoption on any failure. Repeatable.',
          }),
      runContractsAdopt,
    )
    .command<VerifyArgs>(
      'verify [sheets...]',
      'Offline conformance gate: every declared contract resolves + is valid + canonical, and every record conforms (default: all declaring sheets)',
      (yy) => yy.positional('sheets', { type: 'string', array: true }),
      runContractsVerify,
    )
    .command<TestArgs>(
      'test <sheet>',
      "Consumer-side structural check: validate <sheet>'s records against an arbitrary document (a file, or a vendored contract name) — rung 2",
      (yy) =>
        yy
          .positional('sheet', { type: 'string', demandOption: true })
          .option('against', {
            type: 'string',
            demandOption: true,
            describe: 'A file path or the name of a vendored contract',
          }),
      runContractsTest,
    )
    .command<SyncArgs>(
      'sync [names...]',
      "Re-fetch each contract's recorded source and report drift against the vendored bytes (never rewrites)",
      (yy) => yy.positional('names', { type: 'string', array: true }),
      runContractsSync,
    )
    .command<ExportArgs>(
      'export <name>',
      'Emit a vendored contract as interchange JSON on stdout',
      (yy) => yy.positional('name', { type: 'string', demandOption: true }),
      runContractsExport,
    )
    .command<PruneArgs>(
      'prune',
      'List (and with confirmation, remove) vendored documents no sheet declares',
      (yy) =>
        yy
          .option('dry-run', { type: 'boolean', default: false, describe: 'List only; nothing is removed' })
          .option('yes', { type: 'boolean', default: false, describe: 'Skip the removal confirmation prompt' }),
      runContractsPrune,
    )
    .demandCommand(1, 'Specify a contracts subcommand: adopt, verify, test, sync, export, prune');
}
