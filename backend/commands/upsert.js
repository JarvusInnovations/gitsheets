const fs = require('fs');
const TOML = require('@iarna/toml');
const { parse: csvParse } = require('fast-csv');
const deepmerge = require('deepmerge');

const inputFormats = {
  json: readJsonFile,
  toml: readTomlFile,
  csv: readCsvFile,
};

exports.command = 'upsert <sheet> [file]';
exports.desc = 'Upsert a record into a sheet';
exports.builder = {
  sheet: {
    describe: 'Name of sheet to upsert into',
  },
  file: {
    describe: 'File to read JSON/TOML record from, or - for JSON from STDIN, or inline JSON',
    default: '-',
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
  format: {
    describe: 'Format to parse input data in (defaults to file extension or json)',
    choices: Object.keys(inputFormats),
  },
  encoding: {
    describe: 'Encoding to read input with',
    default: 'utf8',
  },
  'attachments.<attachment-path>': {
    describe: 'One or more files to attach in the format <extension>:<source-path>',
  },
  'delete-missing': {
    describe: 'Enable to remove all existing records in the sheet that are not present in the new set',
    type: 'boolean',
    default: false,
  },
  'patch-existing': {
    describe: 'For existing records, patch in provided values so that additional properties not included in the input are preserved',
    type: 'boolean',
    default: false,
  },
};

exports.handler = async function upsert({
  sheet: sheetName,
  file = null,
  root = null,
  prefix = null,
  format = null,
  encoding,
  attachments = null,
  deleteMissing,
  patchExisting,
  ...argv
}) {
  const logger = require('../lib/logger.js');
  const Repository = require('../lib/Repository.js')
  const path = require('path');

  // apply dynamic defaults
  if (!file || file == '-') {
    file = false;
  }

  if (!format) {
    if (file && file.endsWith('.json')) {
      format = 'json';
    } else if (file && file.endsWith('.toml')) {
      format = 'toml'
    } else if (file && file.endsWith('.csv')) {
      format = 'csv'
    } else {
      format = 'json';
    }
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


  // clear sheet
  let inputSheet = sheet;

  if (deleteMissing) {
    // re-open input sheet
    inputSheet = await sheet.clone();

    // clear target sheet
    await sheet.clear();
  }


  // read incoming record
  const isInlineJson =
    (file[0] == '{' && file[file.length - 1] == '}')
    || file[0] == '[' && file[file.length - 1] == ']';

  const inputRecords = isInlineJson
    ? readJsonString(file, { encoding })
    : inputFormats[format](file, { encoding });



  // upsert record(s) into sheet
  for await (let inputRecord of inputRecords) {

    if (patchExisting) {
      // TODO: move more of this logic inside Sheet class

      // fetch existing record from inputSheet
      const inputRecordPath = await inputSheet.pathForRecord(await inputSheet.normalizeRecord(inputRecord));

      if (inputRecordPath) {
        const { root: inputSheetRoot } = await inputSheet.getCachedConfig();

        // existing record find, merge
        const existingBlob = await inputSheet.dataTree.getChild(`${path.join(inputSheetRoot, inputRecordPath)}.toml`);

        if (existingBlob) {
          const existingRecord = await inputSheet.readRecord(existingBlob);
          inputRecord = deepmerge(existingRecord, inputRecord);
        }
      }
    }

    const { blob: outputBlob, path: outputPath } = await sheet.upsert(inputRecord, { patchExisting });
    console.log(`${outputBlob.hash}\t${outputPath}`);

    if (attachments) {
      for (const attachmentPath in attachments) {
        let attachment = attachments[attachmentPath];
        const splitIndex = attachment.indexOf(':');

        // determine extension
        let extension;
        if (splitIndex >= 0) {
          extension = attachment.substr(0, splitIndex);
          if (extension) {
            extension = `.${extension}`;
          }
          attachment = attachment.substr(splitIndex + 1);
        } else {
          extension = path.extname(attachment);
        }

        // prepare blob
        let blob;
        try {
          blob = await repo.writeBlobFromFile(attachment);
        } catch (err) {
          throw new Error(`Could not read ${attachment}: ${err}`);
        }

        // write attachment
        await sheet.setAttachment(inputRecord, `${attachmentPath}${extension}`, blob);
      }
    }
  }


  // write changes to workspace
  const workspace = await repo.getWorkspace();
  await workspace.writeWorkingChanges();
};

async function* readJsonString(string, { encoding }) {
  const data = JSON.parse(string);

  for (const record of Array.isArray(data) ? data : [data]) {
    yield record;
  }
}

async function* readJsonFile(file, { encoding }) {
  const stream = file ? fs.createReadStream(file) : process.stdin;

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const data = JSON.parse(Buffer.concat(chunks).toString(encoding));

  for (const record of Array.isArray(data) ? data : [data]) {
    yield record;
  }
}

async function* readTomlFile(file, { encoding }) {
  const stream = file ? fs.createReadStream(file) : process.stdin;

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const data = TOML.parse(Buffer.concat(chunks).toString(encoding));

  yield data;
}

async function* readCsvFile(file, { encoding }) {
  const stream = file ? fs.createReadStream(file) : process.stdin;

  const csvParseStream = csvParse({ headers: true });

  stream.pipe(csvParseStream);
  for await (const raw of csvParseStream) {
    const record = {};

    for (const key in raw) {
      const value = raw[key];

      if (value === '') {
        continue;
      }

      const subKeys = key.split('.');

      let target = record;
      while (subKeys.length > 1) {
        const subKey = subKeys.shift();

        if (subKey in target) {
          target = target[subKey]
        } else {
          target = target[subKey] = {};
        }
      }

      target[subKeys[0]] = value;
    }

    yield record
  }
}
