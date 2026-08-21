// `contracts list|verify|test` — agent-facing surface for
// specs/behaviors/contracts.md's producer verify gate + consumer
// verification ladder. Read-only by design: `adopt`/`sync`/`prune` stay
// human-CLI-only (adoption is a reviewed, committed act — see
// plans/contracts-axi.md).
//
// Every command here is built from the PUBLIC `gitsheets` package surface —
// `Repository.readBlobStream`/`parseConfigToml` (via ../util/contracts.js),
// `canonicalContractHash`, `validateRecord`, `openSheet({ contract })` — the
// same exports the rest of gitsheets-axi already consumes. None of this
// imports from `gitsheets`'s internal `cli/contracts.ts` (not part of the
// package's public export map). Actual JSON-Schema validation is always
// delegated to the public `validateRecord`/`openSheet({contract})` — nothing
// here re-implements schema checking; the only host-side assembly is the
// documented, mechanical `implements` → per-contract `validateRecord` call
// (equivalent to the spec's `allOf` composition — a conjunction of
// independent schemas is satisfied iff every branch is, so validating each
// declared contract plus the local schema separately is exactly the same
// gate, without hand-building an `allOf` array).

import { isAbsolute, join, relative } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { AxiError } from 'axi-sdk-js';
import {
  canonicalContractHash,
  parseToml,
  ValidationError,
  RECORD_PATH_KEY,
  validateRecord,
  type JSONSchema,
  type Repository,
} from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { countRecords } from '../output/sheet-schema.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import {
  checkVendoredContractIdentity,
  hasClosedAdditionalProperties,
  joinNamesOr,
  listVendoredContractNames,
  readSheetImplements,
  readVendoredContractText,
} from '../util/contracts.js';

export const CONTRACTS_HELP = `usage: gitsheets-axi contracts <subcommand> [args] [flags]
subcommands[3]:
  list                              Vendored contracts + each sheet's implements (default)
  verify [<sheet>...]               Offline producer gate: declared contracts resolve + every record conforms
  test <sheet> --against <f-or-n>   Consumer-side rung-2 check against any file or vendored contract name
flags[1]:
  --against <f-or-n>   test only: a JSON/TOML schema file path, or a vendored contract name
examples:
  gitsheets-axi contracts
  gitsheets-axi contracts list
  gitsheets-axi contracts verify
  gitsheets-axi contracts verify meals users
  gitsheets-axi contracts test posts --against gitsheets.io/posts/v1
  gitsheets-axi contracts test posts --against ./posts-contract.json
behavior:
  list: every vendored contract under .gitsheets/contracts/ (name, canonical
  hash, declaring sheets) plus every sheet's own \`implements\` declaration.
  verify: the offline producer gate (specs/behaviors/contracts.md) — for each
  sheet that declares \`implements\`, resolves every named contract and
  validates every existing record against it (plus the sheet's own
  [gitsheet.schema]). Per-sheet outcome: ok / warning (a closed local schema
  that could reject conforming contract data) / failed / skipped (no
  declared contracts). Default (no sheets given): every sheet in the repo.
  test: rung-2 (structural) consumer verification — validates every record
  of <sheet> against the given document, whether or not the sheet declares
  that contract (or any contract at all). Pure duck typing.
exit codes:
  0    verify/test: every checked sheet/record is ok/warning/skipped/conforming
  1    CONTRACT_UNSATISFIED — one or more sheets/records failed
notes:
  Read-only. Adopting, syncing, or pruning vendored contracts is a reviewed,
  committed act — use the human \`git sheet contracts\` CLI for those.
`;

export async function contractsCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0) return contractsList(ctx);

  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return contractsList(ctx);
    case 'verify':
      return contractsVerify(rest, ctx);
    case 'test':
      return contractsTest(rest, ctx);
    case '--help':
      return CONTRACTS_HELP;
    default:
      throw new AxiError(`Unknown subcommand: ${sub}`, 'VALIDATION_ERROR', [
        'Subcommands: list, verify, test',
      ]);
  }
}

// --- list --------------------------------------------------------------------

async function contractsList(ctx: GitsheetsContext): Promise<string> {
  const repo = await ctx.repo();
  const treeRef = await repo.currentReadTree();

  let sheets: Awaited<ReturnType<typeof repo.openSheets>>;
  try {
    sheets = await repo.openSheets();
  } catch (error) {
    throw translateError(error);
  }
  const sheetNames = Object.keys(sheets).sort();

  const implementsBySheet = new Map<string, string[]>();
  for (const name of sheetNames) {
    implementsBySheet.set(name, await readSheetImplements(repo, treeRef, name));
  }

  const vendoredNames = await listVendoredContractNames(repo, treeRef);
  const contractRows: Array<Record<string, unknown>> = [];
  for (const name of vendoredNames) {
    let hash = '(unreadable)';
    try {
      const text = await readVendoredContractText(repo, treeRef, name);
      hash = canonicalContractHash(text, { format: 'toml' });
    } catch {
      // leave as '(unreadable)' — surfaced via the row itself, not a hard failure
    }
    const declaredBy = sheetNames.filter((s) => implementsBySheet.get(s)!.includes(name));
    contractRows.push({ name, hash, declared_by: joinNamesOr(declaredBy) });
  }

  const sheetRows = sheetNames.map((name) => ({
    sheet: name,
    implements: joinNamesOr(implementsBySheet.get(name) ?? []),
  }));

  const output: Record<string, unknown> = {
    contracts:
      contractRows.length > 0
        ? contractRows
        : 'no vendored contracts in this repository',
    sheets:
      sheetRows.length > 0 ? sheetRows : 'no sheets configured in this repository',
  };

  const help: string[] = [];
  if (contractRows.length === 0 && sheetRows.length === 0) {
    help.push(
      'No sheets or contracts yet — see .gitsheets/<name>.toml (sheet config) and the `git sheet contracts adopt` human CLI command',
    );
  } else {
    if (contractRows.length > 0) {
      help.push('Run `gitsheets-axi contracts verify` to check every declaring sheet conforms');
    }
    if (sheetRows.length > 0) {
      help.push(
        'Run `gitsheets-axi contracts test <sheet> --against <file-or-name>` to check any sheet, contract-aware or not',
      );
    }
  }
  output['help'] = help;

  return renderObject(output);
}

// --- verify ------------------------------------------------------------------

type VerifyOutcome = 'ok' | 'warning' | 'failed' | 'skipped';

interface IssueRow {
  sheet: string;
  contract: string;
  record: string;
  path: string;
  message: string;
}

function issueLine(issue: IssueRow): string {
  const contract = issue.contract ? ` [${issue.contract}]` : '';
  return `${issue.sheet} ${issue.record} ${issue.path}: ${issue.message}${contract}`;
}

async function contractsVerify(args: string[], ctx: GitsheetsContext): Promise<string> {
  const positional = args.filter((a) => !a.startsWith('-'));

  const repo = await ctx.repo();
  const treeRef = await repo.currentReadTree();

  let sheetNames: string[];
  if (positional.length > 0) {
    sheetNames = positional;
  } else {
    let sheets: Awaited<ReturnType<typeof repo.openSheets>>;
    try {
      sheets = await repo.openSheets();
    } catch (error) {
      throw translateError(error);
    }
    sheetNames = Object.keys(sheets).sort();
  }

  const results: Array<{ sheet: string; outcome: VerifyOutcome; contracts: string; issues: number }> = [];
  const issues: IssueRow[] = [];

  for (const sheetName of sheetNames) {
    const sheet = await openSheetForCommand(repo, sheetName);
    const config = await sheet.readConfig();
    const implementsNames = await readSheetImplements(repo, treeRef, sheetName);

    if (implementsNames.length === 0) {
      results.push({ sheet: sheetName, outcome: 'skipped', contracts: '(none)', issues: 0 });
      continue;
    }

    const contractSchemas: Array<{ name: string; schema: JSONSchema }> = [];
    let loadFailed = false;
    for (const name of implementsNames) {
      let text: string;
      try {
        text = await readVendoredContractText(repo, treeRef, name);
      } catch (error) {
        loadFailed = true;
        issues.push({
          sheet: sheetName,
          contract: name,
          record: '(declaration)',
          path: 'implements',
          message: translateError(error).message,
        });
        continue;
      }

      const problems = checkVendoredContractIdentity(name, text);
      if (problems.length > 0) {
        loadFailed = true;
        for (const problem of problems) {
          issues.push({ sheet: sheetName, contract: name, record: '(declaration)', path: 'implements', message: problem });
        }
        continue;
      }

      contractSchemas.push({ name, schema: parseToml(text) as JSONSchema });
    }

    if (loadFailed) {
      results.push({
        sheet: sheetName,
        outcome: 'failed',
        contracts: joinNamesOr(implementsNames),
        issues: issues.filter((i) => i.sheet === sheetName).length,
      });
      continue;
    }

    let sheetIssueCount = 0;
    for await (const record of sheet.query()) {
      const recordPath = String((record as Record<symbol, unknown>)[RECORD_PATH_KEY] ?? '(unknown)');
      const plain = { ...record } as Record<string, unknown>;

      for (const { name, schema } of contractSchemas) {
        try {
          await validateRecord({ record: plain, schema, schemaSourcePath: `.gitsheets/contracts/${name}.toml` });
        } catch (error) {
          if (!(error instanceof ValidationError)) throw translateError(error);
          for (const issue of error.issues) {
            issues.push({
              sheet: sheetName,
              contract: name,
              record: recordPath,
              path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
              message: issue.message,
            });
            sheetIssueCount++;
          }
        }
      }

      if (config.schema) {
        try {
          await validateRecord({ record: plain, schema: config.schema, schemaSourcePath: `.gitsheets/${sheetName}.toml` });
        } catch (error) {
          if (!(error instanceof ValidationError)) throw translateError(error);
          for (const issue of error.issues) {
            issues.push({
              sheet: sheetName,
              contract: '',
              record: recordPath,
              path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
              message: issue.message,
            });
            sheetIssueCount++;
          }
        }
      }
    }

    const closedLocalSchema = config.schema ? hasClosedAdditionalProperties(config.schema) : false;
    if (closedLocalSchema) {
      issues.push({
        sheet: sheetName,
        contract: '',
        record: '(config)',
        path: 'gitsheet.schema.additionalProperties',
        message:
          'local schema sets additionalProperties: false, which can reject contract-conforming records under allOf composition',
      });
    }

    const outcome: VerifyOutcome =
      sheetIssueCount > 0 ? 'failed' : closedLocalSchema ? 'warning' : 'ok';
    results.push({ sheet: sheetName, outcome, contracts: joinNamesOr(implementsNames), issues: sheetIssueCount });
  }

  const failing = results.filter((r) => r.outcome === 'failed');
  if (failing.length > 0) {
    const failingIssues = issues.filter((i) => failing.some((r) => r.sheet === i.sheet));
    const first = failingIssues[0];
    const lines = failingIssues.slice(1).map(issueLine);
    lines.push(
      `Run \`gitsheets-axi contracts verify ${failing.map((r) => r.sheet).join(' ')}\` to isolate, or \`gitsheets-axi contracts list\` for a repo-wide view`,
    );
    throw new AxiError(
      `${failing.length} of ${results.length} sheet(s) failed contract verification` +
        (first ? `: ${issueLine(first)}` : ''),
      'CONTRACT_UNSATISFIED',
      lines,
    );
  }

  const warnings = issues.filter((i) => i.path === 'gitsheet.schema.additionalProperties');
  const output: Record<string, unknown> = {
    sheets: results.map((r) => ({ sheet: r.sheet, outcome: r.outcome, contracts: r.contracts, issues: r.issues })),
  };
  if (warnings.length > 0) {
    output['warnings'] = warnings.map(issueLine);
  }
  const help: string[] = [];
  if (results.every((r) => r.outcome === 'skipped')) {
    help.push('No checked sheet declares any contracts — see `gitsheets-axi contracts list`');
  } else {
    help.push('Run `gitsheets-axi contracts list` to see the vendored contracts + declaring sheets');
  }
  output['help'] = help;

  return renderObject(output);
}

// --- test --------------------------------------------------------------------

type SchemaFormat = 'json' | 'toml';

function sniffFormat(path: string, text: string): SchemaFormat {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.toml')) return 'toml';
  return text.trimStart().startsWith('{') ? 'json' : 'toml';
}

async function resolveAgainst(
  repo: Repository,
  treeRef: string,
  against: string,
): Promise<{ text: string; format: SchemaFormat; description: string }> {
  const absPath = isAbsolute(against) ? against : join(process.cwd(), against);
  let isFile = false;
  try {
    isFile = (await stat(absPath)).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    const text = await readFile(absPath, 'utf-8');
    return {
      text,
      format: sniffFormat(against, text),
      description: relative(process.cwd(), absPath) || against,
    };
  }
  try {
    const text = await readVendoredContractText(repo, treeRef, against);
    return { text, format: 'toml', description: against };
  } catch (error) {
    throw translateError(error);
  }
}

function parseTestFlags(args: string[]): { sheet: string; against: string } {
  let sheet: string | undefined;
  let against: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--against') {
      const next = args[i + 1];
      if (!next) throw new AxiError('--against expects a file path or contract name', 'VALIDATION_ERROR');
      against = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi contracts test --help`',
      ]);
    }
    if (sheet === undefined) sheet = arg;
  }
  if (!sheet) {
    throw new AxiError('contracts test requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi contracts test posts --against gitsheets.io/posts/v1',
    ]);
  }
  if (!against) {
    throw new AxiError('contracts test requires --against <file-or-name>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi contracts test posts --against ./posts-contract.json',
    ]);
  }
  return { sheet, against };
}

async function contractsTest(args: string[], ctx: GitsheetsContext): Promise<string> {
  const { sheet: sheetName, against } = parseTestFlags(args);
  const repo = await ctx.repo();
  const treeRef = await repo.currentReadTree();

  const resolved = await resolveAgainst(repo, treeRef, against);

  const sheet = await openSheetForCommand(repo, sheetName, {
    contract: { schema: resolved.text, format: resolved.format, mode: 'structural' },
  });

  const recordCount = await countRecords(sheet);
  const report = sheet.contractVerification;

  return renderObject({
    result: 'conforms',
    sheet: sheetName,
    against: resolved.description,
    rung: report?.rung ?? 'structural',
    records_checked: recordCount,
    help: [
      recordCount === 0
        ? `${sheetName} has no records — trivially conforms`
        : `${sheetName}'s ${recordCount} record(s) conform to ${resolved.description}`,
    ],
  });
}
