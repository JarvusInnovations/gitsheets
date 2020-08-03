const path = require('path');
const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');
const Configurable = require('hologit/lib/Configurable');

const PathTemplate = require('./path/Template.js');


const WRITE_QUEUES = new Map();


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

    if (!config) {
      return null;
    }

    if (!config.path) {
      throw new Error('path missing');
    }

    return config;
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
      const record = await blob.read().then(TOML.parse);

      for (const key in query) {
        const queryValue = query[key]
        const recordValue = record[key]

        if (typeof queryValue === 'function') {
          if (!queryValue(recordValue, record)) {
            continue BLOBS;
          }
        } else if (record[key] !== queryValue) {
          continue BLOBS;
        }
      }

      yield record;
    }
  }

  async queryFirst (query) {
    return await this.query(query).next();
  }

  async normalizeRecord (record) {
    const { fields = {} } = await this.getCachedConfig();

    // apply declared fields
    for (const field in fields) {
      const {
        default: defaultValue = null,
        enum: enumValues = null,
      } = fields[field];

      if (!(field in record)) {
        record[field] = defaultValue;
      }

      if (enumValues && enumValues.indexOf(record[field])) {
        throw new Error(`field ${field} contains invalid enum value: ${record[field]}`);
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
}

module.exports = Sheet;


// private library
function stringifyRecord(record) {
  return TOML.stringify(sortKeys(record, { deep: true }));
}
