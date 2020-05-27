const path = require('path');
const LiteralComponent = require('./LiteralComponent.js');
const FieldComponent = require('./FieldComponent.js');
const ExpressionComponent = require('./ExpressionComponent.js');
// const Query = require('./Query.js');

const FIELD_EXPRESSION_RE = /^[a-zA-Z0-9_\-]+$/;
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

  async* queryTree (tree, query, depth = 0) { // TODO: convert to generator
    const numComponents = this.#components.length;

    if (!tree) {
      // no results if tree doesn't exist
      return;
    }

    for (let i = depth, currentTree = tree; i < numComponents; i++) {
      const isLast = i +1 == numComponents;
      const nextName = this.#components[i].render(query);

      if (isLast) {
        if (nextName) {
          const child = await currentTree.getChild(`${nextName}.toml`);

          if (child) {
            yield child;
          }

          // absolute match on a leaf, we're done with this query
          return;
        } else {
          // each record in current tree is a result
          const children = await currentTree.getChildren();
          for (const childName in children) {
            if (!childName.endsWith('.toml')) {
              continue;
            }

            const child = children[childName];

            if (!child.isBlob) {
              continue;
            }

            yield child;
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
        for (const childName in children) {
          const child = children[childName];

          if (!child.isTree) {
            continue;
          }

          yield* this.queryTree(child, query, i+1);
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
