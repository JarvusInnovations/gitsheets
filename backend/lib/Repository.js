const path = require('path');
const Sheet = require('./Sheet.js');
const { Repo: HoloRepo, BlobObject } = require('hologit/lib');

class Repository extends HoloRepo
{
  async openSheet (name, { root = '/', dataTree: dataTreeInput = null }) {
    const { workspace, sheetsPath, dataTree } = await _loadConfig(this, root, dataTreeInput);

    return new Sheet({
      workspace,
      dataTree,
      name,
      configPath: path.join(sheetsPath, `${name}.toml`),
    });
  }

  async openSheets ({ root = '/', dataTree: dataTreeInput = null }) {
    const { workspace, sheetsPath, sheetsTree, dataTree } = await _loadConfig(this, root, dataTreeInput);

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


// private library
async function _loadConfig(repo, root, dataTree) {
  const workspace = await repo.getWorkspace();

  root = path.join('.', root);

  if (typeof dataTree == 'string') {
    dataTree = await workspace.root.getSubtree(path.join(root, dataTree), true);
  } else if (!dataTree) {
    dataTree = await workspace.root.getSubtree(root);
  }

  const sheetsPath = path.join(root, '.gitsheets');
  const sheetsTree = await workspace.root.getSubtree(sheetsPath);

  if (!sheetsTree) {
    throw new Error(`could not open sheets tree at ${sheetsPath}`);
  }

  return {
    workspace,
    sheetsPath,
    sheetsTree,
    dataTree,
  };
}
