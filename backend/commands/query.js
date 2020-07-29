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
  // encoding: {
  //   describe: 'Encoding to write output with',
  //   default: 'utf8',
  // },
  limit: {
    describe: 'Truncate results to given count',
    type: 'number'
  },
  'filter.<field>': {
    describe: 'Filter results by one or more field values',
  },
  fields: {
    describe: 'List of fields to order/limit output columns with',
    type: 'array'
  },
  'fields.<from>': {
    describe: 'Fields to remap',
    type: 'array'
  }
};

exports.handler = async function query({
  sheet: sheetName,
  root,
  prefix,
  format,
  // encoding,
  limit,
  filter,
  fields,
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
  let result = sheet.query(filter);


  // apply limit
  if (limit) {
    result = limitResult(result, limit);
  }


  // apply field shaping
  if (fields) {
    result = mapResult(result, fields);
  }


  // output results
  switch (format) {
    case 'json': return outputJson(result);
    case 'csv': return outputCsv(result);
    case 'toml': return outputToml(result);
    default: throw new Error(`Unsupported output format: ${format}`);
  }
};

async function* limitResult(result, limit) {
  let count = 0;

  for await (const record of result) {
    count++;
    yield record;

    if (count >= limit) {
      break;
    }
  }
}

async function* mapResult(result, fields) {
  for await (const record of result) {
    const output = {};

    for (const field of fields) {
      if (typeof field == 'object') {
        for (const from in field) {
          output[field[from]] = record[from];
        }
      } else {
        output[field] = record[field];
      }
    }

    yield output;
  }
}

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
