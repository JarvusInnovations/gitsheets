exports.command = 'query <sheet>';
exports.desc = 'Read records from a sheet';
exports.builder = {
  sheet: {
    describe: 'Name of sheet to upsert into',
  },
  root: {
    describe: 'Root path to .gitsheets in repository (defaults to GITSHEETS_ROOT or /)',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths (defaults to GITSHEETS_PREFIX or none)',
  },
  format: {
    describe: 'Format to serialize output data in (defaults to json)',
    choices: ['json', 'csv', 'toml'],
    default: 'json',
  },
  encoding: {
    describe: 'Encoding to write output with',
    default: 'utf-8',
  },
  'filter.<field>': {
    describe: 'Filter results by one or more field values',
  }
};

exports.handler = async function query({
  sheet: sheetName,
  root = null,
  prefix = null,
  format = 'json',
  encoding,
  filter = null,
  ...argv
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


  // get sheet
  const sheet = await repo.openSheet(sheetName, { root, dataTree: prefix });

  if (!sheet) {
    throw new Error(`sheet '${sheetName}' not found under ${root}/.gitsheets/`);
  }

  logger.debug('loaded sheet:', sheet);


  // query records
  const result = sheet.query(filter);


  // output results
  switch (format) {
    case 'json': return outputJson(result);
    case 'csv': return outputCsv(result);
    case 'toml': return outputToml(result);
    default: throw new Error(`Unsupported output format: ${format}`);
  }
};

async function outputJson(result) {
  let firstRecord = true;

  console.log('[');

  for await (const record of result) {
    if (firstRecord) {
      console.log(`${JSON.stringify(record)}`);
      firstRecord = false;
    } else {
      console.log(`,${JSON.stringify(record)}`);
    }
  }

  console.log(']');
}

async function outputCsv(result) {
  const { Readable } = require('stream');
  const { format: csvFormat } = require('fast-csv');
  const csvStream = csvFormat({ headers: true, includeEndRowDelimiter: true });

  csvStream.pipe(process.stdout).on('end', () => process.exit());

  Readable.from(result).pipe(csvStream);
}

async function outputToml(result) {
  const TOML = require('@iarna/toml');
  let firstRecord = true;

  for await (const record of result) {
    if (firstRecord) {
      console.log(`${TOML.stringify(record)}`);
      firstRecord = false;
    } else {
      console.log(`\0\n${TOML.stringify(record)}`);
    }
  }
}
