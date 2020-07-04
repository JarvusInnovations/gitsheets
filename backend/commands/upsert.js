exports.command = 'upsert <sheet> [file]';
exports.desc = 'Upsert a record into a sheet';
exports.builder = {
  sheet: {
    describe: 'Name of sheet to upsert into',
  },
  file: {
    describe: 'File to read JSON/TOML record from, or - for JSON from STDIN',
    default: '-',
  },
  root: {
    describe: 'Root path to .gitsheets in repository (defaults to GITSHEETS_ROOT or /)',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths (defaults to GITSHEETS_PREFIX or none)',
  },
  format: {
    describe: 'Format to parse input data in (defaults to file extension or json)',
    choices: ['json', 'toml']
  },
  encoding: {
    describe: 'Encoding to read input with',
    default: 'utf-8'
  }
};

exports.handler = async function init({
  sheet: sheetName,
  file = null,
  root = null,
  prefix = null,
  format = null,
  encoding,
  ...argv
}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js')
  const path = require('path');
  const fs = require('mz/fs');
  const TOML = require('@iarna/toml');

  const { GITSHEETS_ROOT, GITSHEETS_PREFIX } = process.env;

  // apply dynamic defaults
  if (!file || file == '-') {
    file = 0; // STDIN
  }

  if (!root) {
    root = GITSHEETS_ROOT || '/';
  }

  if (!prefix) {
    prefix = GITSHEETS_PREFIX || null;
  }

  if (!format) {
    if (file && file.endsWith('.json')) {
      format = 'json';
    } else if (file && file.endsWith('.toml')) {
      format = 'toml'
    } else {
      format = 'json';
    }
  }

  // get repo interface
  const repo = await Repository.getFromEnvironment({ working: true });
  logger.debug('instantiated repository:', repo);


  // get sheets
  const sheet = await repo.openSheet(sheetName, { root, dataTree: prefix });

  if (!sheet) {
    throw new Error(`sheet '${sheetName}' not found under ${root}/.gitsheets/`);
  }

  logger.debug('loaded sheet:', sheet);


  // read incoming record
  const inputString = await fs.readFile(file, encoding);
  const inputData = (format == 'toml' ? TOML : JSON).parse(inputString);


  // upsert record(s) into sheet
  for (const inputRecord of Array.isArray(inputData) ? inputData : [inputData]) {
    const outputBlob = await sheet.upsert(inputRecord);
    console.log(outputBlob.hash);
  }


  // write changes to workspace
  const workspace = await repo.getWorkspace();
  await workspace.writeWorkingChanges();
};
