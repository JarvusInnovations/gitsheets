const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');
const Configurable = require('hologit/lib/Configurable');

const PathTemplate = require('./path/Template.js');


const WRITE_QUEUES = new Map();

const SORT_CLOSURE = Symbol('sort#closure');
const DIFF_STATUS_MAP = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
};


// primary export
class Sheet extends Configurable
{
  static async finishWriting (repo) {
    for (const [sheet, writeQueue] of WRITE_QUEUES) {
      if (sheet.workspace.getRepo() === repo) {
        await Promise.all(writeQueue);
      }
    }
  }

  #recordCache;

  constructor ({ workspace, name, dataTree = null, configPath = null }) {
    if (!workspace) {
      throw new Error('workspace required');
    }

    if (!name) {
      throw new Error('name required');
    }

    super(...arguments);

    this.name = name;
    this.configPath = configPath || `.gitsheets/${name}.toml`;
    this.dataTree = dataTree || workspace.root;

    this.#recordCache = new Map();

    Object.freeze(this);
  }

  getKind () {
    return 'gitsheet';
  }

  getConfigPath () {
    return this.configPath;
  }

  async readConfig () {
    const config = await super.readConfig();
    const { fields } = config;

    if (!config) {
      return null;
    }

    if (!config.path) {
      throw new Error('gitsheet.path must be declared');
    }

    if (fields) {
      if (typeof fields != 'object') {
        throw new Error('gitsheet.fields must be a table');
      }

      for (const field in fields) {
        const { sort } = fields[field];
        if (typeof sort == 'object') {
          if (Array.isArray(sort)) {
            for (const sortField of sort) {
              if (typeof sortField != 'string') {
                throw new Error(`gitsheet.fields.${field}.sort[] must be string field names`);
              }
            }
          } else {
            for (const sortField in sort) {
              const sortDir = sort[sortField];
              if (sortDir != 'ASC' && sortDir != 'DESC') {
                throw new Error(`gitsheet.fields.${field}.sort.${sortField} must be ASC or DESC`);
              }
            }
          }
        }
      }
    }

    return config;
  }

  async readRecord (blob) {
    const cache = this.#recordCache.get(blob.hash);

    if (cache) {
      return v8.deserialize(cache);
    }

    const record = await blob.read().then(TOML.parse);
    this.#recordCache.set(blob.hash, v8.serialize(record));

    return record;
  }

  /**
   *
   * @param {Object|Function} query
   */
  async* query (query) {
    const {
      root: sheetRoot,
      path: pathTemplateString,
    } = await this.getCachedConfig();

    if (typeof query == 'function') {
      throw new Error('function queries are not yet supported');
    }

    const pathTemplate = PathTemplate.fromString(pathTemplateString);
    const sheetDataTree = await this.dataTree.getSubtree(sheetRoot);

    BLOBS: for await (const blob of pathTemplate.queryTree(sheetDataTree, query)) {
      const record = await this.readRecord(blob);

      if (!queryMatches(query, record)) {
        continue BLOBS;
      }

      yield record;
    }
  }

  async queryFirst (query) {
    return (await this.query(query).next()).value;
  }

  async queryAll (query) {
    const records = [];

    for await (const record of this.query(query)) {
      records.push(record);
    }

    return records;
  }

  async normalizeRecord (record) {
    const { fields = {} } = await this.getCachedConfig();

    // apply declared fields
    for (const field in fields) {
      const {
        default: defaultValue = null,
        enum: enumValues = null,
        sort = null,
        [SORT_CLOSURE]: cachedSorter,
      } = fields[field];

      if (!(field in record)) {
        record[field] = defaultValue;
      }

      if (enumValues && enumValues.indexOf(record[field])) {
        throw new Error(`field ${field} contains invalid enum value: ${record[field]}`);
      }

      if (sort) {
        const array = record[field];
        if (array && Array.isArray(array)) {
          array.sort(cachedSorter || (fields[field][SORT_CLOSURE] = buildSorter(sort)));
        }
      }
    }

    return record;
  }

  async clear () {
    const { root } = await this.getCachedConfig();
    return this.dataTree.writeChild(root, this.dataTree.repo.createTree());
  }

  async upsert (record) {
    const {
      root: sheetRoot,
      path: pathTemplateString,
    } = await this.getCachedConfig();

    const pathTemplate = PathTemplate.fromString(pathTemplateString);

    // get write queue
    let writeQueue = WRITE_QUEUES.get(this);
    if (!writeQueue) {
      writeQueue = new Set();
      WRITE_QUEUES.set(this, writeQueue);
    }

    // apply normalization before building path
    const normalRecord = await this.normalizeRecord(record);

    // build record path
    const recordPath = pathTemplate.render(normalRecord);
    if (!recordPath) {
      throw new Error('could not generate any path for record');
    }

    // write record
    const toml = stringifyRecord(normalRecord);
    const writePromise = this.dataTree.writeChild(`${path.join(sheetRoot, recordPath)}.toml`, toml);

    writeQueue.add(writePromise);
    const blob = await writePromise;
    writeQueue.delete(writePromise);

    // return compound data object
    return {
      blob,
      path: recordPath,
    };
  }

  async delete (record) {
    const { root: sheetRoot, path: pathTemplateString } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      const pathTemplate = PathTemplate.fromString(pathTemplateString);
      record = pathTemplate.render(record);
    }

    return this.dataTree.deleteChild(`${path.join(sheetRoot, record)}.toml`);
  }

  async getAttachments (record) {
    const { root: sheetRoot, path: pathTemplateString } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      const pathTemplate = PathTemplate.fromString(pathTemplateString);
      record = pathTemplate.render(record);
    }

    const attachmentsTree = await this.dataTree.getChild(path.join(sheetRoot, record));

    return attachmentsTree
      ? attachmentsTree.getBlobMap()
      : null;
  }

  async getAttachment (record, attachment) {
    const { root: sheetRoot, path: pathTemplateString } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      const pathTemplate = PathTemplate.fromString(pathTemplateString);
      record = pathTemplate.render(record);
    }

    return this.dataTree.getChild(path.join(sheetRoot, record, attachment));
  }

  async setAttachments (record, attachments) {
    const { root: sheetRoot, path: pathTemplateString } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      const pathTemplate = PathTemplate.fromString(pathTemplateString);
      record = pathTemplate.render(record);
    }

    return Promise.all(Object.keys(attachments).map(
      attachment =>
        this.dataTree.writeChild(
          path.join(sheetRoot, record, attachment),
          attachments[attachment]
        )
    ));
  }

  async setAttachment (record, attachment, blob) {
    const attachments = {};
    attachments[attachment] = blob;
    return this.setAttachments(record, attachments);
  }

  async finishWriting() {
    const writeQueue = WRITE_QUEUES.get(this);

    if (!writeQueue) {
      return;
    }

    return Promise.all(writeQueue);
  }

  async* diffSince (sinceCommitHash) {
    const repo = this.getRepo();
    const {
      root: sheetRoot,
    } = await this.getCachedConfig();

    const sinceTreeHash = await repo.resolveRef(`${sinceCommitHash}:${sheetRoot}`);
    if (!sinceTreeHash) {
      throw new Error(`unable to resolve since tree ${sinceCommitHash}:${sheetRoot}`);
    }

    const untilTree = await this.dataTree.getChild(sheetRoot);
    const untilTreeHash = await untilTree.write();

    for await (const change of diffTrees(repo, sinceTreeHash, untilTreeHash)) {
      // TODO: parse with https://www.npmjs.com/package/fast-json-patch
      yield change;
    }
  }
}

module.exports = Sheet;


// private library
function stringifyRecord(record) {
  return TOML.stringify(sortKeys(record, { deep: true }));
}

function queryMatches(query, record) {
  KEYS: for (const key in query) {
    const queryValue = query[key]
    const recordValue = record[key]

    switch (typeof queryValue) {
    case 'function':
      if (!queryValue(recordValue, record)) {
        return false;
      }

      continue KEYS;
    case 'object':
      if (!queryMatches(queryValue, recordValue)) {
        return false;
      }

      continue KEYS;
    default:
      if (record[key] !== queryValue) {
        return false;
      }

      continue KEYS;
    }
  }

  return true;
}

function buildSorter (config) {
  switch (typeof config) {
  case 'object':
    if (Array.isArray(config)) {
      const configMap = {};
      for (const field of config) {
        configMap[field] = 'ASC';
      }
      config = configMap;
    }

    const expression = [];
    for (const field in config) {
      const direction = config[field] == 'ASC' ? 1 : -1;
      expression.push(
        `if (a.${field} < b.${field}) return ${-1 * direction}`,
        `if (a.${field} > b.${field}) return ${1 * direction}`,
      );
    }
    expression.push('return 0');
    config = expression.join(';\n');
    // fall through now that config is a string
  case 'string':
    sorter = vm.runInNewContext(`(a, b) => {\n${config}\n}`);
    return sorter;
  default:
    throw new Error('sort must be an expression in a string, a field:direction table, or field array');
  }
}

async function* diffTrees (repo, since, until) {
  const git = await repo.getGit();

  const diff = await git.diffTree(
    { $spawn: true, z: true, r: true },
    since,
    until,
    '**/*.toml',
  );

  // read error
  let error = '';
  for await (const chunk of diff.stderr) {
    error += chunk;
  }

  if (error) {
    throw new Error(error);
  }

  // read output
  let output = '';
  let status;
  for await (const chunk of diff.stdout) {
    output += chunk;

    let nullIndex;
    while ((nullIndex = output.indexOf('\0')) >= 0) {
      const value = output.slice(0, nullIndex);

      if (status) {
        yield parseDiffLine(status, value);
        status = null;
      } else {
        status = value;
      }

      output = output.slice(nullIndex + 1);
    }
  }

  if (output.length > 0 && status) {
    yield parseDiffLine(status, output);
  }

  const exitCode = await new Promise( (resolve, reject) => {
    diff.on('close', resolve);
  });

  if (exitCode != 0) {
    throw new Error(`git-diff-tree exited with code ${exitCode}`);
  }
}

function parseDiffLine (statusLine, path) {
  const [
    srcMode, dstMode,
    srcBlobHash, dstBlobHash,
    status,
  ] = statusLine.substr(1).split(' ');

  return {
    path: path.substr(0, path.length - 5),
    status: DIFF_STATUS_MAP[status[0]],
    statusCount: parseInt(status.substr(1), 10) || null,
    srcMode, dstMode,
    srcBlobHash, dstBlobHash,
  };
}
