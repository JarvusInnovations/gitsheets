exports.command = 'read <record-path>';
exports.desc = 'Read a record, converting to desired format';
exports.builder = {
  'record-path': {
    type: 'string',
    describe: 'The path to a record file to read',
    demandOption: true,
  },
  encoding: {
    type: 'string',
    default: 'utf8',
  },
  format: {
    describe: 'Format to serialize output data in (defaults to json)',
    choices: ['json', 'csv', 'tsv', 'toml'],
    default: 'json',
  },
  headers: {
    describe: 'Whether to show headers in output formats that have headers (i.e. csv)',
    type: 'boolean',
    default: true,
  },
};

exports.handler = async function edit({ recordPath, encoding, format, headers }) {
  const fs = require('fs');
  const { spawn } = require('child_process');
  const TOML = require('@iarna/toml');
  const Repository = require('../lib/Repository.js');
  const Sheet = require('../lib/Sheet.js')
  const repo = await Repository.getFromEnvironment({ working: true });
  const git = await repo.getGit();

  // open record
  const recordToml = fs.readFileSync(recordPath, encoding);

  // parse record
  const record = TOML.parse(recordToml);

  // output results
  switch (format) {
    case 'json': return outputJson(record);
    case 'csv': return outputCsv(record, { headers });
    case 'tsv': return outputCsv(record, { headers, delimiter: '\t' });
    case 'toml': return outputToml(record);
    default: throw new Error(`Unsupported output format: ${format}`);
  }
};


// library
async function outputJson(record) {
  console.log(`${JSON.stringify(record)}`);
}

async function outputCsv(record, { headers = true, delimiter = ',' } = {}) {
  const { format: csvFormat } = require('fast-csv');
  const csvStream = csvFormat({ headers, delimiter, includeEndRowDelimiter: true });

  csvStream.pipe(process.stdout).on('end', () => process.exit());

  csvStream.write(record);
  csvStream.end();
}

async function outputToml(record) {
  const TOML = require('@iarna/toml');
  console.log(`${TOML.stringify(record)}`);
}
