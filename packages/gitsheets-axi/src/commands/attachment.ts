import { isAbsolute, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { AxiError } from 'axi-sdk-js';
import { NotFoundError } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse, renderObject } from '../output/render.js';
import { display, field } from '../output/schema.js';
import { readStdin } from '../util/stdin.js';

export const ATTACHMENT_HELP = `usage: gitsheets-axi attachment <subcommand> [args] [flags]
subcommands[4]:
  list <sheet> <path>                 List attachments on a record
  get <sheet> <path> <name>           Get attachment metadata + base64 content
  set <sheet> <path> <name> [--file f] [--data <text>]
                                      Set an attachment (--file path, --data inline,
                                      or piped on stdin)
  delete <sheet> <path> [<name>]      Delete one attachment by name, or all if name omitted
examples:
  gitsheets-axi attachment list users jane
  gitsheets-axi attachment get users jane avatar.jpg
  gitsheets-axi attachment set users jane avatar.jpg --file ./pic.jpg
  cat pic.jpg | gitsheets-axi attachment set users jane avatar.jpg
  gitsheets-axi attachment delete users jane avatar.jpg
  gitsheets-axi attachment delete users jane
notes:
  Binary content in \`get\` is base64-encoded. Use \`--full\` to opt into
  larger payloads (default cap: 64KB).
`;

const GET_PREVIEW_LIMIT = 64 * 1024;

export async function attachmentCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return ATTACHMENT_HELP;
  }

  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return attachmentList(rest, ctx);
    case 'get':
      return attachmentGet(rest, ctx);
    case 'set':
      return attachmentSet(rest, ctx);
    case 'delete':
      return attachmentDelete(rest, ctx);
    case '--help':
      return ATTACHMENT_HELP;
    default:
      throw new AxiError(`Unknown subcommand: ${sub}`, 'VALIDATION_ERROR', [
        'Subcommands: list, get, set, delete',
      ]);
  }
}

function parseAttachmentBase(args: string[], requireName: boolean): {
  sheet: string;
  path: string;
  name: string | undefined;
  rest: string[];
} {
  const positional: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith('-')) {
      rest.push(arg);
      // Drag along the next token if it looks like a value
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        rest.push(next);
        i++;
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length < 2) {
    throw new AxiError('attachment requires at least <sheet> <path>', 'VALIDATION_ERROR');
  }
  if (requireName && positional.length < 3) {
    throw new AxiError('attachment requires <sheet> <path> <name>', 'VALIDATION_ERROR');
  }
  return {
    sheet: positional[0]!,
    path: positional[1]!,
    name: positional[2],
    rest,
  };
}

async function openTargetSheet(
  ctx: GitsheetsContext,
  sheetName: string,
  prefix: string | undefined,
) {
  const repo = await ctx.repo();
  try {
    return await repo.openSheet(
      sheetName,
      prefix !== undefined ? { prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }
}

function extractPrefix(rest: string[]): string | undefined {
  const i = rest.indexOf('--prefix');
  if (i === -1) return undefined;
  const next = rest[i + 1];
  if (!next) {
    throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
  }
  return next;
}

async function attachmentList(args: string[], ctx: GitsheetsContext): Promise<string> {
  const { sheet: sheetName, path, rest } = parseAttachmentBase(args, false);
  const prefix = extractPrefix(rest);
  const sheet = await openTargetSheet(ctx, sheetName, prefix);

  const items: Array<Record<string, unknown>> = [];
  try {
    for await (const attachment of sheet.attachments(path)) {
      items.push({
        name: attachment.name,
        mime_type: attachment.mimeType,
        hash: attachment.blob.hash,
      });
    }
  } catch (error) {
    throw translateError(error);
  }

  return renderListResponse({
    summary: { sheet: sheetName, record: path },
    name: 'attachments',
    items,
    schema: [field('name'), display('mime_type'), field('hash')],
    emptyMessage: 'no attachments on this record',
    suggestions:
      items.length > 0
        ? [
            `Run \`gitsheets-axi attachment get ${sheetName} ${path} <name>\` to inspect content`,
          ]
        : [
            `Run \`gitsheets-axi attachment set ${sheetName} ${path} <name> --file <path>\` to add one`,
          ],
  });
}

async function attachmentGet(args: string[], ctx: GitsheetsContext): Promise<string> {
  const { sheet: sheetName, path, name, rest } = parseAttachmentBase(args, true);
  const prefix = extractPrefix(rest);
  const full = rest.includes('--full');
  const sheet = await openTargetSheet(ctx, sheetName, prefix);

  let attachmentBlob;
  try {
    attachmentBlob = await sheet.getAttachment(path, name!);
  } catch (error) {
    throw translateError(error);
  }
  if (!attachmentBlob) {
    throw new AxiError(
      `${sheetName}: no attachment ${name} on record at ${path}`,
      'NOT_FOUND',
    );
  }

  let buffer: Buffer;
  try {
    const raw = await attachmentBlob.read();
    buffer = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw);
  } catch (error) {
    throw translateError(error);
  }

  const size = buffer.length;
  const cap = full ? Number.POSITIVE_INFINITY : GET_PREVIEW_LIMIT;
  const truncated = size > cap;
  const slice = truncated ? buffer.subarray(0, GET_PREVIEW_LIMIT) : buffer;

  const output: Record<string, unknown> = {
    attachment: {
      sheet: sheetName,
      record: path,
      name,
      hash: attachmentBlob.hash,
      size,
      base64: slice.toString('base64'),
    },
  };
  if (truncated) {
    (output['attachment'] as Record<string, unknown>)['truncated'] = true;
    output['help'] = [
      `Run \`gitsheets-axi attachment get ${sheetName} ${path} ${name} --full\` to fetch all ${size} bytes`,
    ];
  }
  return renderObject(output);
}

async function attachmentSet(args: string[], ctx: GitsheetsContext): Promise<string> {
  const { sheet: sheetName, path, name, rest } = parseAttachmentBase(args, true);
  const prefix = extractPrefix(rest);

  const fileIdx = rest.indexOf('--file');
  const dataIdx = rest.indexOf('--data');
  const messageIdx = rest.indexOf('--message');
  const fileArg = fileIdx >= 0 ? rest[fileIdx + 1] : undefined;
  const dataArg = dataIdx >= 0 ? rest[dataIdx + 1] : undefined;
  const message = messageIdx >= 0 ? rest[messageIdx + 1] : undefined;

  // Acquire the content bytes.
  let content: string;
  if (fileArg) {
    const absPath = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
    try {
      const buf = await readFile(absPath);
      content = buf.toString('binary');
    } catch (err) {
      throw new AxiError(
        `attachment set: cannot read ${fileArg}: ${err instanceof Error ? err.message : String(err)}`,
        'NOT_FOUND',
      );
    }
  } else if (dataArg) {
    content = dataArg;
  } else {
    content = await readStdin();
    if (!content) {
      throw new AxiError(
        'attachment set needs content — pass --file <path>, --data <text>, or pipe on stdin',
        'VALIDATION_ERROR',
      );
    }
  }

  const repo = await ctx.repo();
  const sheet = await openTargetSheet(ctx, sheetName, prefix);

  // Idempotency: check the existing attachment's content.
  let existing;
  try {
    existing = await sheet.getAttachment(path, name!);
  } catch (error) {
    throw translateError(error);
  }
  if (existing) {
    try {
      const existingText = await existing.read();
      const existingStr =
        typeof existingText === 'string'
          ? existingText
          : Buffer.from(existingText).toString('binary');
      if (existingStr === content) {
        return renderObject({
          result: 'no-op',
          sheet: sheetName,
          record: path,
          name,
          hash: existing.hash,
          reason: 'attachment bytes already match',
        });
      }
    } catch {
      // Fall through and overwrite.
    }
  }

  const commitMessage = message ?? `${sheetName} setAttachment ${name} on ${path}`;
  let commitHash = '';
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          sheetName,
          prefix !== undefined ? { prefix } : {},
        );
        await txSheet.setAttachment(path, name!, content);
      },
    );
    commitHash = result.commitHash ?? '';
  } catch (error) {
    throw translateError(error);
  }

  // Re-open the sheet to look up the new attachment hash — the `sheet`
  // handle above is bound to the pre-commit tree.
  let newHash = '';
  try {
    const fresh = await repo.openSheet(
      sheetName,
      prefix !== undefined ? { prefix } : {},
    );
    const created = await fresh.getAttachment(path, name!);
    newHash = created?.hash ?? '';
  } catch {
    // not fatal — agent has the commit hash already
  }

  return renderObject({
    result: existing ? 'overwritten' : 'created',
    sheet: sheetName,
    record: path,
    name,
    hash: newHash,
    bytes: content.length,
    commit: commitHash,
  });
}

async function attachmentDelete(args: string[], ctx: GitsheetsContext): Promise<string> {
  const { sheet: sheetName, path, name, rest } = parseAttachmentBase(args, false);
  const prefix = extractPrefix(rest);
  const messageIdx = rest.indexOf('--message');
  const message = messageIdx >= 0 ? rest[messageIdx + 1] : undefined;

  const repo = await ctx.repo();
  const sheet = await openTargetSheet(ctx, sheetName, prefix);

  if (name === undefined) {
    // Delete all attachments on the record. Already idempotent in the library.
    const before = await sheet.getAttachments(path);
    const count = before ? Object.keys(before).length : 0;
    if (count === 0) {
      return renderObject({
        result: 'no-op',
        sheet: sheetName,
        record: path,
        reason: 'record has no attachments',
      });
    }
    const commitMessage = message ?? `${sheetName} deleteAttachments on ${path}`;
    let commitHash = '';
    try {
      const result = await repo.transact(
        { message: commitMessage },
        async (tx) => {
          const txSheet = tx.sheet(
            sheetName,
            prefix !== undefined ? { prefix } : {},
          );
          await txSheet.deleteAttachments(path);
        },
      );
      commitHash = result.commitHash ?? '';
    } catch (error) {
      throw translateError(error);
    }
    return renderObject({
      result: 'committed',
      sheet: sheetName,
      record: path,
      deleted: count,
      commit: commitHash,
    });
  }

  // Single-attachment delete; idempotent on already-missing.
  const existing = await sheet.getAttachment(path, name);
  if (!existing) {
    return renderObject({
      result: 'no-op',
      sheet: sheetName,
      record: path,
      name,
      reason: 'attachment already absent',
    });
  }

  const commitMessage = message ?? `${sheetName} deleteAttachment ${name} on ${path}`;
  let commitHash = '';
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          sheetName,
          prefix !== undefined ? { prefix } : {},
        );
        await txSheet.deleteAttachment(path, name);
      },
    );
    commitHash = result.commitHash ?? '';
  } catch (error) {
    if (error instanceof NotFoundError) {
      return renderObject({
        result: 'no-op',
        sheet: sheetName,
        record: path,
        name,
        reason: 'attachment vanished between check and delete',
      });
    }
    throw translateError(error);
  }
  return renderObject({
    result: 'committed',
    sheet: sheetName,
    record: path,
    name,
    commit: commitHash,
  });
}

// stat() is exported here only to keep the import list tidy if we ever need
// file-size pre-checks in attachment set; suppress unused-import noise.
void stat;
