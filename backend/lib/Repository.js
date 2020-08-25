const path = require('path');
const Sheet = require('./Sheet.js');
const { Repo: HoloRepo, BlobObject } = require('hologit/lib');

class Repository extends HoloRepo
{
  constructor(options = {}) {
    super(options);
  }

  async resolveDataTree (root, dataTree) {
    const workspace = await this.getWorkspace();

    root = path.join('.', root);

    if (typeof dataTree == 'string') {
      dataTree = await workspace.root.getSubtree(path.join(root, dataTree), true);
    } else if (!dataTree) {
      dataTree = await workspace.root.getSubtree(root);
    }

    const sheetsPath = path.join(root, '.gitsheets');
    const sheetsTree = await workspace.root.getSubtree(sheetsPath, true);

    return {
      workspace,
      root,
      sheetsPath,
      sheetsTree,
      dataTree,
    };
  }

  async openSheet (name, { root = '/', dataTree: dataTreeInput = null } = {}) {
    const { workspace, sheetsPath, dataTree } = await this.resolveDataTree(root, dataTreeInput);

    return new Sheet({
      workspace,
      dataTree,
      name,
      configPath: path.join(sheetsPath, `${name}.toml`),
    });
  }

  async openSheets ({ root = '/', dataTree: dataTreeInput = null } = {}) {
    const { workspace, sheetsPath, sheetsTree, dataTree } = await this.resolveDataTree(root, dataTreeInput);

    const children = await sheetsTree.getChildren();
    const childNameRe = /^([^\/]+)\.toml$/;

    const sheets = {};

    for (const childName in children) {

      // skip any child not ending in .toml
      const filenameMatches = childName.match(childNameRe);
      if (!filenameMatches) {
        continue;
      }

      // skip any child that is deleted or isn't a blob
      const treeChild = children[childName];
      if (!treeChild || !treeChild.isBlob) {
        continue;
      }

      // read sheet
      const [, name] = filenameMatches;

      sheets[name] = new Sheet({
        workspace,
        dataTree,
        name,
        configPath: path.join(sheetsPath, childName),
      });
    }

    return sheets;
  }

  async finishWriting () {
    // TODO: using this instead of awaiting each upsert isn't safe currently as TreeObject.writeChild isn't safe to parallelize due to async subtree building
    return Sheet.finishWriting(this);
  }
}

module.exports = Repository;
