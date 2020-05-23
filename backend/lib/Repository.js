const path = require('path');
const Sheet = require('./Sheet.js');
const { Repo: HoloRepo, BlobObject } = require('hologit/lib');

class Repository extends HoloRepo
{
  async getSheets (root = '/', outputTree = null) {
    const workspace = await this.getWorkspace();

    root = path.join('.', root);

    if (typeof outputTree == 'string') {
      outputTree = await workspace.root.getSubtree(path.join(root, outputTree), true);
    } else if (!outputTree) {
      outputTree = await workspace.root.getSubtree(root);
    }

    const sheetsPath = path.join(root, '.gitsheets');
    const sheetsTree = await workspace.root.getSubtree(sheetsPath);
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
        outputTree,
        name,
        configPath: path.join(sheetsPath, childName)
      });
    }

    return sheets;
  }

  async finishWriting () {
    return Sheet.finishWriting(this);
  }
}

module.exports = Repository;
