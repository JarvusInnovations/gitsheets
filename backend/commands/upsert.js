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
    describe: 'Root path to .gitsheets in repository (defaults to GITSHEETS_ROOT or /)',
  },
  prefix: {
    describe: 'Path to prefix after root to all sheet paths (defaults to GITSHEETS_PREFIX or none)',
  },
  format: {
    describe: 'Format to parse input data in (defaults to file extension or json)',
    choices: ['json', 'toml'], // TODO: add csv
  },
  encoding: {
    describe: 'Encoding to read input with',
    default: 'utf-8',
  },
  'attachments.<attachment-path>': {
    describe: 'One or more files to attach in the format <extension>:<source-path>',
  }
};

exports.handler = async function upsert({
  sheet: sheetName,
  file = null,
  root = null,
  prefix = null,
  format = null,
  encoding,
  attachments = null,
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


  // get sheet
  const sheet = await repo.openSheet(sheetName, { root, dataTree: prefix });

  if (!sheet) {
    throw new Error(`sheet '${sheetName}' not found under ${root}/.gitsheets/`);
  }

  logger.debug('loaded sheet:', sheet);


  // read incoming record
  const isInlineJson =
    (file[0] == '{' && file[file.length - 1] == '}')
    || file[0] == '[' && file[file.length - 1] == ']';

  const inputString = isInlineJson
    ? file
    : await fs.readFile(file, encoding);

  const inputData = (format == 'toml' ? TOML : JSON).parse(inputString);


  // upsert record(s) into sheet
  for (const inputRecord of Array.isArray(inputData) ? inputData : [inputData]) {
    const outputBlob = await sheet.upsert(inputRecord);
    console.log(outputBlob.hash);

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
