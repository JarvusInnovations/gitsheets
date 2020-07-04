exports.command = 'upsert <sheet> [file]';
exports.desc = 'Upsert a record into a sheet';
exports.builder = {
  sheet: {
    describe: 'Name of sheet to upsert into',
  },
  file: {
    describe: 'File to read JSON record from, or - for STDIN',
    default: '-',
  },
  root: {
    describe: 'Root path to .gitsheets in repository, defaults to /',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths',
  },
};

exports.handler = async function init({
  sheet: sheetName,
  file = null,
  root = null,
  prefix = null,
  ...argv
}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js')
  const path = require('path');
  const fs = require('mz/fs');

  const { GITSHEETS_ROOT, GITSHEETS_PREFIX } = process.env;

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
  const sheet = await repo.openSheet(sheetName, { root, dataTree: prefix });

  if (!sheet) {
    throw new Error(`sheet '${sheetName}' not found under ${root}/.gitsheets/`);
  }

  logger.debug('loaded sheet:', sheet);


  // read incoming record
  const inputString = await fs.readFile(file && file != '-' ? file : 0, 'utf-8');
  const inputData = JSON.parse(inputString);


  // upsert record(s) into sheet
  for (const inputRecord of Array.isArray(inputData) ? inputData : [inputData]) {
    const outputBlob = await sheet.upsert(inputRecord);
    console.log(outputBlob.hash);
  }


  // write changes to workspace
  const workspace = await repo.getWorkspace();
  await workspace.writeWorkingChanges();
};
