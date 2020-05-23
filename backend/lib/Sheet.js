const path = require('path');
const sortKeys = require('sort-keys');
const TOML = require('@iarna/toml');
const Configurable = require('hologit/lib/Configurable');

const Literal = require('./path/Literal.js');
const Field = require('./path/Field.js');
const Expression = require('./path/Expression.js');


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

  constructor ({ workspace, name, outputTree = null, configPath = null }) {
    if (!workspace) {
      throw new Error('workspace required');
    }

    if (!name) {
      throw new Error('name required');
    }

    super(...arguments);

    this.name = name;
    this.configPath = configPath || `.gitsheets/${name}.toml`;
    this.outputTree = outputTree || workspace.root;

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
      .then(({ root: sheetRoot, path: recordPathTemplate }) => {
        const recordPath = path.join(sheetRoot, renderRecordPath(recordPathTemplate, record));
        const toml = stringifyRecord(record);

        console.log('writeChild(%o)', recordPath);
        return this.outputTree.writeChild(`${recordPath}.toml`, toml);
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
const FIELD_EXPRESSION_RE = /^[a-zA-Z0-9_\-]+$/;
const PATH_TEMPLATE_CACHE = new Map();
const PATH_COMPONENT_TEMPLATE = {
  kind: Literal,
  prefix: '',
  name: '',
  suffix: '',
};


function stringifyRecord(record) {
  return TOML.stringify(sortKeys(record, { deep: true }));
}

function renderRecordPath(recordPathTemplate, record) {
  if (typeof recordPathTemplate == 'string') {
    recordPathTemplate = getParsedRecordPathTemplate(recordPathTemplate);
  }

  return recordPathTemplate
    .map(pathComponent => pathComponent.render(record))
    .join('/');
}

function getParsedRecordPathTemplate(recordPathTemplate) {
  let parsedRecordPathTemplate = PATH_TEMPLATE_CACHE.get(recordPathTemplate);

  if (parsedRecordPathTemplate) {
    return parsedRecordPathTemplate;
  }

  parsedRecordPathTemplate = parseRecordPathTemplate(recordPathTemplate);
  PATH_TEMPLATE_CACHE.set(recordPathTemplate, parsedRecordPathTemplate);

  return parsedRecordPathTemplate;
}

function parseRecordPathTemplate(recordPathTemplate) {
  recordPathTemplate = path.join('.', recordPathTemplate, '.');
  const stringLength = recordPathTemplate.length;


  let i = 0, cur = { ...PATH_COMPONENT_TEMPLATE };


  const parsed = [];
  const finishCurrentComponent = () => {
    if (cur.name) {
      parsed.push(new cur.kind(cur));
    }
    cur = { ...PATH_COMPONENT_TEMPLATE };
  };


  while (i < stringLength) {
    const nextChar = recordPathTemplate[i];

    // read an expression from ${{ to }}
    if (nextChar == '$' && recordPathTemplate.substr(i, 3) == '${{') {
      cur.kind = Expression;
      i += 3;

      if (cur.name) {
        cur.prefix = cur.name;
        cur.name = '';
      }

      while (recordPathTemplate.substr(i, 2) != '}}') {
        cur.name += recordPathTemplate[i];
        i++;

        if (i == stringLength) {
          throw new Error(`expression ${cur.name} not closed with }}`);
        }
      }

      // finish reading name expression
      cur.name = cur.name.trim();

      // reduce to Field kind if name is a bare field name
      if (FIELD_EXPRESSION_RE.test(cur.name)) {
        cur.kind = Field;
      }

      // skip }} and continue scan from the top
      i += 2;
      continue;
    }

    // process next character
    if (nextChar == '/') {
      finishCurrentComponent();
    } else if (cur.kind === Expression) {
      cur.suffix += nextChar;
    } else {
      cur.name += nextChar;
    }

    i++;
  }

  finishCurrentComponent();

  return parsed;
}
