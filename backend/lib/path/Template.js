const path = require('path');
const LiteralComponent = require('./LiteralComponent.js');
const FieldComponent = require('./FieldComponent.js');
const ExpressionComponent = require('./ExpressionComponent.js');
// const Query = require('./Query.js');

const FIELD_EXPRESSION_RE = /^[a-zA-Z0-9_\-]+(\/\*\*)?$/;
const INSTANCE_CACHE = new Map();
const PATH_COMPONENT_TEMPLATE = {
  kind: LiteralComponent,
  prefix: '',
  name: '',
  suffix: '',
};

class Template
{
  static fromString (templateString) {
    let instance = INSTANCE_CACHE.get(templateString);

    if (instance) {
      return instance;
    }

    instance = new this(parseRecordPathTemplate(templateString));
    INSTANCE_CACHE.set(templateString, instance);

    return instance;
  }

  #components;

  constructor (templateComponents) {
    this.#components = templateComponents;
  }

  render (record) {
    const recordPath = [];

    for (const component of this.#components) {
      const string = component.render(record);

      if (string === null) {
        throw new Error('unable to render path component');
      }

      recordPath.push(string);
    }

    return recordPath.join('/');
  }

  async* queryTree (tree, query, pathPrefix = '', depth = 0) {
    const numComponents = this.#components.length;

    if (!tree) {
      // no results if tree doesn't exist
      return;
    }

    for (let i = depth, currentTree = tree; i < numComponents; i++) {
      const isLast = i +1 == numComponents;
      const cur = this.#components[i];
      const nextName = cur.render(query);

      if (isLast) {
        if (nextName) {
          const child = await currentTree.getChild(`${nextName}.toml`);

          if (child) {
            yield { path: path.join(pathPrefix, nextName), blob: child };
          }

          // absolute match on a leaf, we're done with this query
          return;
        } else {
          // each record in current tree is a result
          const children = cur.recursive
            ? await currentTree.getBlobMap()
            : await currentTree.getChildren();

          let attachmentsPrefix;

          for (const childPath in children) {
            if (!childPath.endsWith('.toml')) {
              continue;
            }

            if (attachmentsPrefix && childPath.indexOf(attachmentsPrefix) === 0) {
              // this file is an attachment under the previous record
              continue;
            }

            const child = children[childPath];

            if (!child || !child.isBlob) {
              continue;
            }

            const childName = childPath.substr(0, childPath.length - 5);
            attachmentsPrefix = `${childName}/`;
            yield { path: path.join(pathPrefix, childName), blob: child };
          }

          return;
        }
      }

      // crawl down the tree
      if (nextName) {
        const nextTree = await currentTree.getChild(nextName);

        if (nextTree) {
          currentTree = nextTree;
        } else {
          return;
        }
      } else {
        // each tree in current tree could contain matching records
        const children = await currentTree.getChildren();
        for (const childPath in children) {
          const child = children[childPath];

          if (!child.isTree) {
            continue;
          }

          yield* this.queryTree(child, query, path.join(pathPrefix, childPath), i+1);
        }

        return;
      }
    }
  }
}

module.exports = Template;


// private library
function parseRecordPathTemplate(templateString) {
  templateString = path.join('.', templateString, '.');
  const stringLength = templateString.length;


  let i = 0, cur = { ...PATH_COMPONENT_TEMPLATE };


  const parsed = [];
  const finishCurrentComponent = () => {
    if (cur.name) {
      parsed.push(new cur.kind(cur));
    }
    cur = { ...PATH_COMPONENT_TEMPLATE };
  };


  while (i < stringLength) {
    const nextChar = templateString[i];

    // read an expression from ${{ to }}
    if (nextChar == '$' && templateString.substr(i, 3) == '${{') {
      cur.kind = ExpressionComponent;
      i += 3;

      if (cur.name) {
        cur.prefix = cur.name;
        cur.name = '';
      }

      while (templateString.substr(i, 2) != '}}') {
        cur.name += templateString[i];
        i++;

        if (i == stringLength) {
          throw new Error(`expression ${cur.name} not closed with }}`);
        }
      }

      // finish reading name expression
      cur.name = cur.name.trim();

      // reduce to Field kind if name is a bare field name
      if (FIELD_EXPRESSION_RE.test(cur.name)) {
        cur.kind = FieldComponent;

        if (cur.name.endsWith('/**')) {
          cur.recursive = true;
          cur.name = cur.name.substr(0, cur.name.length - 3);
        }
      }

      // skip }} and continue scan from the top
      i += 2;
      continue;
    }

    // process next character
    if (nextChar == '/') {
      finishCurrentComponent();
    } else if (cur.kind !== LiteralComponent) {
      cur.suffix += nextChar;
    } else {
      cur.name += nextChar;
    }

    i++;
  }

  finishCurrentComponent();

  return parsed;
}
