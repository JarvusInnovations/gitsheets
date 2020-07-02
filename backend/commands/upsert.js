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
    describe: 'Root path to .gitsheets in repository',
    default: '/',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths',
  },
};

exports.handler = async function init({ sheet: sheetName, root, prefix = null, file = null } = {}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js')
  const path = require('path');
  const fs = require('mz/fs');


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
  const inputRecord = JSON.parse(inputString);


  // upsert record into sheet
  const outputBlob = await sheet.upsert(inputRecord);


  // write changes to workspace
  const workspace = await repo.getWorkspace();
  await workspace.writeWorkingChanges();


  // return upserted record
  console.log(outputBlob.hash);
  return outputBlob.hash;
};
