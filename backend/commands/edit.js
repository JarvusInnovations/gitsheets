exports.command = 'edit <record-path> [resume-path]';
exports.desc = 'Edit a record, validating and formatting it automatically';
exports.builder = {
  'record-path': {
    type: 'string',
    describe: 'The path to a record file to edit',
    demandOption: true,
  },
  'resume-path': {
    type: 'string',
    describe: 'If set, read initial editor content from this file instead of the target record',
  },
  encoding: {
    type: 'string',
    default: 'utf8',
  },
};

exports.handler = async function edit({ recordPath, resumePath, encoding }) {
  const fs = require('fs');
  const { spawn } = require('child_process');
  const path = require('path');
  const tmp = require('tmp');
  const TOML = require('@iarna/toml');
  const Repository = require('../lib/Repository.js');
  const Sheet = require('../lib/Sheet.js')
  const repo = await Repository.getFromEnvironment({ working: true });
  const git = await repo.getGit();

  // open record
  const recordToml = fs.readFileSync(resumePath || recordPath, encoding);

  // get temp path
  const { name: tempFilePath } = tmp.fileSync({
    prefix: path.basename(recordPath, '.toml'),
    postfix: '.toml',
    discardDescriptor: true,
  });

  // populate temp path
  fs.writeFileSync(tempFilePath, recordToml, encoding);

  // get editor
  const editor = (await git.var('GIT_EDITOR')) || 'vim';

  // invoke editor
  try {
    const editorProcess = spawn('sh', ['-c', `eval ${editor} ${tempFilePath}`], { stdio: 'inherit' });
    const exitCode = await new Promise(resolve => editorProcess.on('close', resolve));

    if (exitCode !== 0) {
      console.error(`editor exited with code ${exitCode}, canceling edit`);
      fs.unlinkSync(tempFilePath);
      process.exit(exitCode);
    }
  } catch (err) {
    console.error(`Failed to invoke editor: ${err}`);
  }

  // read and clean up temp file
  const editedToml = fs.readFileSync(tempFilePath, encoding);

  // parse toml
  let editedRecord;
  try {
    editedRecord = TOML.parse(editedToml);
  } catch (err) {
    console.error(`Failed to parse record:\n${err}`);
    console.error(`To resume editing, run: git sheet edit ${recordPath} ${tempFilePath}`);
    process.exit(1);
  }

  // delete temp file
  fs.unlinkSync(tempFilePath);

  // save normalized TOML to input path
  fs.writeFileSync(recordPath, Sheet.stringifyRecord(editedRecord));
  process.exit(0);
};


// library
