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

    if (!config.path) {
      throw new Error('path missing');
    }

    return config;
  }

  async upsert (record) {
    let writeQueue = WRITE_QUEUES.get(this);

    if (!writeQueue) {
      writeQueue = new Set();
      WRITE_QUEUES.set(this, writeQueue);
    }

    const writePromise = this.getCachedConfig()
      .then(({ root: sheetRoot, path: pathTemplateString }) => {
        const pathTemplate = PathTemplate.fromString(pathTemplateString);
        const recordPath = path.join(sheetRoot, pathTemplate.render(record));
        const toml = stringifyRecord(record);

        return this.dataTree.writeChild(`${recordPath}.toml`, toml);
      })


    writeQueue.add(writePromise);
    await writePromise;
    writeQueue.delete(writePromise);

    return writePromise;
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
