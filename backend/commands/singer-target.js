exports.command = 'singer-target';
exports.desc = 'Load one or more streams from a Singer tap';
exports.builder = {
  working: {
    type: 'boolean',
    default: true,
    defaultDescription: 'true if ref empty',
  },
  ref: {
    type: 'string',
    description: 'Git ref to use as input instead of working tree',
    defaultDescription: '--commit-to',
  },
  'commit-to': {
    type: 'string',
    description: 'Git ref to commit containing gitsheets to update',
  },
  root: {
    type: 'string',
    describe: 'Root path to .gitsheets in repository (defaults to GITSHEETS_ROOT or /)',
    default: process.env.GITSHEETS_ROOT || '/',
    defaultDescription: 'GITSHEETS_ROOT || "/"',
  },
  prefix: {
    type: 'string',
    describe: 'Path to prefix after root to all sheet paths (defaults to GITSHEETS_PREFIX or none)',
    default: process.env.GITSHEETS_PREFIX,
    defaultDescription: 'GITSHEETS_PREFIX',
  },
  'delete-missing': {
    type: 'boolean',
    describe: 'Delete all existing records in the sheet that are not present in the new set',
    default: false,
  },
};

exports.handler = async function singerTarget({
  working,
  ref,
  commitTo,
  root,
  prefix,
  deleteMissing,
}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js');
  const { TreeObject } = require('../lib/hologit');
  const path = require('path');

  const EMPTY_TREE_HASH = TreeObject.getEmptyTreeHash()

  // apply dynamic defaults
  if (commitTo && !ref) {
    ref = commitTo
  }

  if (ref) {
    working = false;
  }

  if (commitTo && !commitTo.startsWith('refs/heads/')) {
    commitTo = `refs/heads/${commitTo}`;
  }


  // get repo interface
  let repo = await Repository.getFromEnvironment({ working: working, ref: ref });
  let git = await repo.getGit()

  let parentCommitHash = await repo.resolveRef();
  if (!parentCommitHash) {
    // initialize ref or hard crash
    if (commitTo) {
      parentCommitHash = await git.commitTree(EMPTY_TREE_HASH, {
        m: `↥ initialize gitsheets workspace ${commitTo}`,
      });
      repo = await Repository.getFromEnvironment({ ref: parentCommitHash });
      git = await repo.getGit()
    } else {
      throw new Error(`input --ref ${ref} could not be resolved, configure --commit-to to initialize automatically`);
    }
  }


  // open all sheets
  const sheets = await repo.openSheets({ root, dataTree: prefix });


  // upsert record(s) into sheets
  const clearedSheets = new Set();
  const writtenStreams = new Set();
  for await (const { type, stream, ...message} of readMessages()) {
    const sheet = sheets[stream];

    console.log(`${type}\t${stream}`, message);


    // create schema if needed
    if (!sheet) {
      if (type == 'SCHEMA') {
        sheets[stream] = await repo.openSheet(stream, {
          root,
          dataTree: prefix,
          config: {
            root: stream,
            path: message.key_properties.map(p => '${{ '+p+' }}').join('/'),
            fields: message.schema && message.schema.properties || null,
          },
        });
        await sheets[stream].writeConfig();
        continue;
      } else {
        throw new Error(`no sheet defined for stream ${stream} and first message was not schema`);
      }
    } else if (type == 'SCHEMA') {
      console.warn('ignoring SCHEMA for already-defined sheet');
      continue;
    }


    // ignore state for now
    if (type == 'STATE') {
      console.warn('ignoring STATE message');
      continue;
    }


    // handle record message
    if (type == 'RECORD') {
      if (deleteMissing && !clearedSheets.has(sheet)) {
        console.log(`clearing sheet ${sheet.name}`);
        await sheet.clear();
        clearedSheets.add(sheet);
      }

      const { blob: outputBlob, path: outputPath } = await sheet.upsert(message.record);
      console.log(`${outputBlob.hash}\t${outputPath}`);
      writtenStreams.add(stream);
      continue;
    }


    // hard crash for any unexpected type
    throw new Error(`encountered unknown Singer message type: ${type}`);
  }


  // write changes to workspace or ref
  const workspace = await repo.getWorkspace();

  if (working) {
    await workspace.writeWorkingChanges();
  } else if (commitTo) {
    const treeHash = await workspace.root.write();

    if (treeHash != await git.getTreeHash(parentCommitHash)) {
      const commitHash = await git.commitTree(treeHash, {
        p: parentCommitHash,
        m: `⭆ load data from Singer tap\n\nWritten streams: ${Array.from(writtenStreams).join(', ')}`,
      });
      await git.updateRef(commitTo, commitHash);
      console.log(`committed new tree to "${commitTo}": ${parentCommitHash}->${commitHash}`);
    } else {
      console.log('tree unchanged');
    }
  } else {
    // output tree hash
    console.log(await workspace.root.write());
  }
};


// library
async function* readMessages () {
  // read input
  let output = '';
  for await (const chunk of process.stdin) {
    output += chunk;

    let eolIndex;
    while ((eolIndex = output.indexOf('\n')) >= 0) {
      yield JSON.parse(output.slice(0, eolIndex));

      output = output.slice(eolIndex + 1);
    }
  }

  if (output.length > 0) {
    yield JSON.parse(output);
  }
}
