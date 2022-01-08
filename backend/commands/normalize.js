exports.command = 'normalize [sheet...]';
exports.desc = 'Normalize the content of any hand-edited records to be consistent';
exports.builder = {
  sheet: {
    describe: 'Name of sheet to upsert into',
    type: 'array',
  },
  root: {
    describe: 'Root path to .gitsheets in repository (defaults to GITSHEETS_ROOT or /)',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths (defaults to GITSHEETS_PREFIX or none)',
  },
};

exports.handler = async function query({
  sheet: selectedSheets,
  root,
  prefix,
}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js')
  const path = require('path');
  const fs = require('mz/fs');

  const { GITSHEETS_ROOT, GITSHEETS_PREFIX } = process.env;

  // apply dynamic defaults
  if (!root) {
    root = GITSHEETS_ROOT || '/';
  }

  if (!prefix) {
    prefix = GITSHEETS_PREFIX || null;
  }

  // get repo interface
  const repo = await Repository.getFromEnvironment({ working: true });
  logger.debug('instantiated repository:', repo);


  // get sheets
  const sheets = await repo.openSheets({ root, dataTree: prefix });


  // loop through selected, or all sheets
  const sheetNames = selectedSheets || Object.keys(sheets);

  for (const sheetName of sheetNames) {
    const sheet = sheets[sheetName];

    if (!sheet) {
      throw new Error(`sheet ${sheetName} is not defined`);
    }

    // loop through all records and re-upsert
    try {
      for await (const record of sheet.query()) {
        logger.info(`rewriting ${sheetName}/${record[Symbol.for('gitsheets-path')]}`);
        await sheet.upsert(record);
      }
    } catch (err) {
      if (err.constructor.name == 'TomlError') {
        logger.error(`failed to parse ${path.join(root, prefix, err.file)}\n${err.message}`);
        process.exit(1);
      }

      throw err;
    }
  }


  // write changes to workspace
  const workspace = await repo.getWorkspace();
  await workspace.writeWorkingChanges();
};
