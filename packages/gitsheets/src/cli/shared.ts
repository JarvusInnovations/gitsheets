// Shared CLI types + helpers used across command modules (`index.ts`,
// `contracts.ts`). Split out to avoid a circular import between them — both
// need `GlobalArgs`/`buildTxOpts`, and `index.ts` imports command-group
// registration functions (e.g. `registerContractsCommands`) from the modules
// that need these.

export interface GlobalArgs {
  gitDir?: string;
  root?: string;
  prefix?: string;
  ref?: string;
  commitTo?: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  trailer?: Record<string, string>;
}

export interface TxOpts {
  message: string;
  author?: { name: string; email: string };
  trailers?: Record<string, string>;
  parent?: string;
  branch?: string;
}

/** Build `repo.transact` options from the global CLI flags shared by every mutating command. */
export function buildTxOpts(argv: GlobalArgs, defaultMessage: string): TxOpts {
  const opts: TxOpts = { message: argv.message ?? defaultMessage };
  if (argv.authorName && argv.authorEmail) {
    opts.author = { name: argv.authorName, email: argv.authorEmail };
  }
  if (argv.trailer && Object.keys(argv.trailer).length > 0) {
    opts.trailers = argv.trailer;
  }
  if (argv.ref) opts.parent = argv.ref;
  if (argv.commitTo) opts.branch = argv.commitTo;
  return opts;
}
