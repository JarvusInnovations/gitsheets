const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');
const rfc6902 = require('rfc6902');
const Configurable = require('hologit/lib/Configurable');
const TreeObject = require('hologit/lib/TreeObject');

const PathTemplate = require('./path/Template.js');

const EMPTY_TREE_HASH = TreeObject.getEmptyTreeHash();


const WRITE_QUEUES = new Map();

const RECORD_SHEET_KEY = Symbol.for('gitsheets-sheet');
const RECORD_PATH_KEY = Symbol.for('gitsheets-path');
const SORT_CLOSURE_KEY = Symbol('sort#closure');
const DIFF_STATUS_MAP = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
};


// primary export
class Sheet extends Configurable
{
  static stringifyRecord (record) {
    return TOML.stringify(sortKeys(record, { deep: true }));
  }

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

  async readRecord (blob, path = null) {
    const cache = this.#recordCache.get(blob.hash);

    const record = cache
      ? v8.deserialize(cache)
      : await blob.read().then(TOML.parse);

    // annotate with gitsheets keys
    record[RECORD_SHEET_KEY] = this.name;
    if (path) {
      record[RECORD_PATH_KEY] = path;
    }

    // fill cache
    if (!cache) {
      this.#recordCache.set(blob.hash, v8.serialize(record));
    }

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

      record[RECORD_PATH_KEY] = pathTemplate.render(record);

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

  async pathForRecord (record) {
    const { path: pathTemplateString } = await this.getCachedConfig();
    return PathTemplate.fromString(pathTemplateString).render(record);
  }

  async normalizeRecord (record) {
    const { fields = {} } = await this.getCachedConfig();

    // apply declared fields
    for (const field in fields) {
      const {
        type = null, // JSON Schema compatible
        enum: enumValues = null, // JSON Schema compatible
        default: defaultValue = null, // non-standard
        sort = null, // non-standard
        trueValues = null, // non-standard
        falseValues = null, // non-standard
        [SORT_CLOSURE_KEY]: cachedSorter,
      } = fields[field];

      // read or default value
      let value;
      if (field in record) {
        value = record[field];
      } else {
        value = defaultValue;
      }

      // null values need no further processing
      if (value === null || value === undefined || value === '') {
        record[field] = null
        continue;
      }

      // coerce numbers/strings/booleans to desired type
      const valueType = typeof value;
      switch (type) {
      case 'number':
        if (valueType != 'number') {
          if (valueType == 'string') {
            value = Number(value);
          } else {
            throw new Error(`field ${field} contains value of type ${typeof value} that cannot be converted to a number`);
          }
        }
        break;
      case 'string':
        if (valueType != 'string') {
          if (valueType == 'number') {
            value = String(value);
          } else {
            throw new Error(`field ${field} contains value of type ${typeof value} that cannot be converted to a string`);
          }
        }
        break;
      case 'boolean':
        if (valueType != 'boolean') {
          if (trueValues || falseValues) {
            if (trueValues && trueValues.indexOf(value) != -1) {
              value = true;
            } else if (falseValues && falseValues.indexOf(value) != -1) {
              value = false;
            } else {
              value = null;
            }
          } else {
            value = Boolean(value);
          }
        }
        break;
      }

      // validate enum values
      if (enumValues && enumValues.indexOf(value) == -1) {
        throw new Error(`field ${field} contains invalid enum value: ${value}`);
      }

      // sort array
      if (sort) {
        if (Array.isArray(value)) {
          value.sort(cachedSorter || (fields[field][SORT_CLOSURE_KEY] = buildSorter(sort)));
        } else {
          throw new Error(`field ${field} defines sort but contains non-array value: ${value}`);
        }
      }

      record[field] = value;
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

    // delete previous record
    const recordExistingPath = record[RECORD_PATH_KEY];
    if (recordExistingPath && recordExistingPath != recordPath) {
      await this.delete(recordExistingPath);
    }

    // write record
    const toml = this.constructor.stringifyRecord(normalRecord);
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
    const { root: sheetRoot } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      record = await this.pathForRecord(record);
    }

    return this.dataTree.deleteChild(`${path.join(sheetRoot, record)}.toml`);
  }

  async getAttachments (record) {
    const { root: sheetRoot } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      record = await this.pathForRecord(record);
    }

    const attachmentsTree = await this.dataTree.getChild(path.join(sheetRoot, record));

    return attachmentsTree
      ? attachmentsTree.getBlobMap()
      : null;
  }

  async getAttachment (record, attachment) {
    const { root: sheetRoot } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      record = await this.pathForRecord(record);
    }

    return this.dataTree.getChild(path.join(sheetRoot, record, attachment));
  }

  async setAttachments (record, attachments) {
    const { root: sheetRoot } = await this.getCachedConfig()

    if (typeof record !== 'string') {
      record = await this.pathForRecord(record);
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

  async* diffFrom (srcCommitHash = null, { blobs = false, records = false, patches = false } = {}) {
    const repo = this.getRepo();
    const {
      root: sheetRoot,
    } = await this.getCachedConfig();

    const srcTreeHash = srcCommitHash
      ? await repo.resolveRef(`${srcCommitHash}:${sheetRoot}`)
      : EMPTY_TREE_HASH;

    if (srcCommitHash && !srcTreeHash) {
      throw new Error(`unable to resolve src tree ${srcCommitHash}:${sheetRoot}`);
    }

    const dstTree = await this.dataTree.getChild(sheetRoot);
    const dstTreeHash = await dstTree.write();

    let diff = diffTrees(repo, srcTreeHash, dstTreeHash);

    if (blobs || records || patches) {
      diff = this.loadDiffBlobs(diff);
    }

    if (records || patches) {
      diff = this.loadDiffRecords(diff);
    }

    if (patches) {
      diff = this.loadDiffPatches(diff);
    }

    yield* diff;
  }

  async* loadDiffBlobs (diff) {
    const repo = this.getRepo();

    for await (const change of diff) {
      change.srcBlob = change.srcMode == '000000'
        ? null
        : repo.createBlob({ mode: change.srcMode, hash: change.srcHash });

      change.dstBlob = change.dstMode == '000000'
        ? null
        : repo.createBlob({ mode: change.dstMode, hash: change.dstHash });

      yield change;
    }
  }


  async* loadDiffRecords (diff) {
    for await (const change of diff) {
      [ change.src, change.dst ] = await Promise.all([
        change.srcBlob ? this.readRecord(change.srcBlob) : null,
        change.dstBlob ? this.readRecord(change.dstBlob, change.path) : null,
      ]);

      yield change;
    }
  }

  async* loadDiffPatches (diff) {
    for await (const change of diff) {
      change.patch = rfc6902.createPatch(change.src, change.dst, rfc6902DiffAny);
      yield change;
    }
  }
}

module.exports = Sheet;


// private library
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
        `if ((a.${field}) < (b.${field})) return ${-1 * direction}`,
        `if ((a.${field}) > (b.${field})) return ${1 * direction}`,
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

async function* diffTrees (repo, src, dst) {
  const git = await repo.getGit();

  const diffProcess = await git.diffTree(
    { $spawn: true, z: true, r: true },
    src,
    dst,
    '**/*.toml',
  );

  const exitCodePromise = new Promise(resolve => diffProcess.on('close', resolve));

  // read error
  let error = '';
  diffProcess.stderr.on('data', chunk => error += chunk);

  // read output
  let output = '';
  let status;
  for await (const chunk of diffProcess.stdout) {
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

  const exitCode = await exitCodePromise;

  if (exitCode != 0 || error) {
    throw new Error(`git-diff-tree exited with code ${exitCode}: ${error}`);
  }
}

function parseDiffLine (statusLine, path) {
  const [
    srcMode, dstMode,
    srcHash, dstHash,
    status,
  ] = statusLine.substr(1).split(' ');

  return {
    path: path.substr(0, path.length - 5),
    status: DIFF_STATUS_MAP[status[0]],
    statusCount: parseInt(status.substr(1), 10) || null,
    srcMode, dstMode,
    srcHash, dstHash,
  };
}

function rfc6902DiffAny (input, output, ptr) {
  if (input instanceof Date && output instanceof Date && input.valueOf() != output.valueOf()) {
    return [{op: 'replace', path: ptr.toString(), value: output}]
  }
}
