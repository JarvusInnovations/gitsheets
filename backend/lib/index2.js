const { Repo, BlobObject } = require('hologit/lib');
const { ReadableStream } = require('stream');
const TOML = require('@iarna/toml');
const maxstache = require('maxstache');
const jsonpatch = require('fast-json-patch');

const {
  SerializationError,
  ConfigError,
  InvalidRefError,
} = require('./errors')

const DIFF_PATTERN = /([A-Z])\d*\t(\S+)\t?(\S*)/;
const diffStatusMap = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
};

/**
 * @class
 */
module.exports = class GitSheets {
  static async create(gitDir = null) {
    const repo = (gitDir)
      ? new Repo({ gitDir })
      : await Repo.getFromEnvironment();
    const git = await repo.getGit();

    return new GitSheets(repo, git);
  }

  constructor (repo, git) {
    this.repo = repo;
    this.git = git;
  }

  async getConfig (ref) {
    const tree = await this._createTreeFromRef(ref);
    const child = await tree.getChild('.gitsheets/config'); // TODO: Wrap errors
    if (!child) return {};

    const contents = await child.read(); // TODO: Wrap errors
    return this._deserialize(contents);
  }

  async getConfigItem (ref, key) {
    const config = await this.getConfig(ref);
    if (!config.hasOwnProperty(key)) {
      throw new ConfigError(`config is missing property ${key}`)
    } else {
      return config[key];
    }
  }

  /**
   * Save a config object to .gitsheets/config on an existing branch
   * @public
   * @param {treeish} ref - Ref of parent tree
   * @param {Object} config - Config object to save
   * @return {Promise}
   */
  async setConfig (ref, config) {
    const path = '.gitsheets/config';
    const contents = this._serialize(config);
    const tree = await this._createTreeFromRef(ref);
    await tree.writeChild(path, contents); // TODO: Wrap errors
    const treeHash = await tree.write();
    await this._saveTreeToExistingBranch({
      treeHash,
      branch: ref,
      msg: 'set config',
    });
  }

  async setConfigItem (ref, key, value) {
    const config = await this.getConfig(ref);
    const newConfig = { ...config, [key]: value };
    await this.setConfig(ref, newConfig);
  }

  /**
   * Serialise a dataset and commit it onto current or new branch
   * @public
   * @param {Object} opts
   * @param {ReadableStream} opts.data - Stream of data to be imported
   * @param {string} [opts.dataType] - Type of input data (valid: csv)
   * @param {treeish} opts.parentRef - Ref of parent tree
   * @param {boolean} opts.merge - Whether to merge/upsert data, as opposed to replace
   * @param {string} [opts.saveToBranch] - Branch name to create or update. Omit to not save.
   * @return {Promise<string>} - Tree hash
   */
  async import ({
    data,
    dataType = null,
    parentRef,
    merge = false,
    saveToBranch = null,
  }) {
    const pathTemplate = await this.getConfigItem(parentRef, 'path');

    const treeObject = (merge)
      ? await this._createTreeFromRef(parentRef)
      : await this._createTruncatedTree(parentRef);

    const treeHash = await this._writeDataToTree({
      data: this._attachDataParser(data, dataType),
      treeObject,
      pathTemplate,
    });

    if (saveToBranch && saveToBranch === parentRef) { // TODO: check if branch exists instead
      await this._saveTreeToExistingBranch({
        treeHash,
        branch: saveToBranch,
        msg: 'import to existing branch',
      });
    } else if (saveToBranch) {
      await this._saveTreeToNewBranch({
        treeHash,
        parentRef,
        branch: saveToBranch,
        msg: 'import to new branch',
      });
    }

    return treeHash;
  }

  async export (ref) {
    const treeObject = await this._createTreeFromRef(ref);

    const keyedChildren = await treeObject.getBlobMap();
    const pendingReads = Object.entries(keyedChildren)
      .reduce((accum, [key, child]) => {
        if (key.startsWith('.gitsheets/')) return accum;

        if (child instanceof BlobObject) {
          accum.push(
            child.read() // TODO: Wrap errors
              .then(this._deserialize)
              .then((data) => ({ ...data, _id: key }))
          );
        }
        return accum;
      }, []);
    
    return Promise.all(pendingReads);
  }

  async compare (srcRef, dstRef) {
    const [srcBlobMap, dstBlobMap] = await Promise.all([
      this._getBlobMapFromRef(srcRef),
      this._getBlobMapFromRef(dstRef),
    ]);

    const diffs = await this._getDiffs(srcRef, dstRef);

    const fullDiffs = diffs.map(({ status, path, newPath }) => ({
      added: async () => ({
        _id: path,
        status,
        value: await this._parseBlob(dstBlobMap[path]),
      }),
      deleted: async () => ({
        _id: path,
        status,
        value: await this._parseBlob(srcBlobMap[path]),
      }),
      modified: async () => ({
        _id: path,
        status,
        patch: await this._generatePatch(srcBlobMap[path], dstBlobMap[path]),
      }),
      renamed: async () => ({
        _id: path,
        status: 'modified',
        patch: await this._generatePatch(srcBlobMap[path], dstBlobMap[newPath]),
      }),
    }[status]()));

    return Promise.all(fullDiffs);
  }

  async _getBlobMapFromRef (ref) {
    const treeObject = await this._createTreeFromRef(ref);
    return treeObject.getBlobMap();
  }

  async _generatePatch (srcBlob, dstBlob) {
    const [srcData, dstData] = await Promise.all([
      this._parseBlob(srcBlob),
      this._parseBlob(dstBlob),
    ]);
    return this._compareObjects(srcData, dstData);
  }

  async _getDiffs (srcRef, dstRef) {
    const output = await this.git.diff({'name-status': true}, srcRef, dstRef);

    return output
      .trim()
      .split('\n')
      .map(this._parseDiffLine)
      .filter((diff) => diff.status !== null)
  }

  _parseDiffLine (line) {
    const [ , statusCode, path, newPath ] = line.match(DIFF_PATTERN);
    const status = diffStatusMap[statusCode] || null;
    return { status, path, newPath };
  }

  _parseBlob (blob) {
    return blob.read()
      .then(this._deserialize);
  }

  _compareObjects (src, dst) {
    const includeTestOps = true;
    const ops = jsonpatch.compare(src, dst, includeTestOps);
    return ops;
    // return this.mergeTestAndReplaceOps(ops);
  }

  /**
   * WARNING: mutates tree
   */
  _writeDataToTree ({ data, treeObject, pathTemplate }) {
    return new Promise((resolve, reject) => {
      const pendingWrites = [];

      data
        .on('data', (row) => {
          const path = this._renderTemplate(pathTemplate, row);
          const contents = this._serialize(row);

          pendingWrites.push(treeObject.writeChild(path, contents));
        })
        .on('end', () => {
          Promise.all(pendingWrites)
            .then(() => treeObject.write())
            .then(resolve)
            .catch(reject);
        })
        .on('error', reject); // TODO: Wrap errors?
    })
  }

  _attachDataParser (data, dataType) {
    if (dataType === 'csv') {
      return data.pipe(csvParser({ strict: true }));
    } else {
      return data;
    }
  }

  /**
   * Wraps Hologit.Repo.createTreeFromRef with error matching
   * @private
   */
  async _createTreeFromRef (parent) {
    try {
      return await this.repo.createTreeFromRef(parent);
    } catch (err) {
      if (err.message.startsWith('invalid tree ref')) {
        throw new InvalidRefError('unknown ref');
      } else {
        throw err;
      }
    }
  }

  /**
   * Creates an empty tree and merges GitSheets config
   * @private
   */
  async _createTruncatedTree (parent) {
    const parentTree = await this._createTreeFromRef(parent);
    const tree = this.repo.createTree();
    await tree.merge(parentTree, { files: ['.gitsheets/*'] });
    return tree;
  }

  _serialize (row) {
    try {
      return TOML.stringify(this._sortObjectKeys(row));
    } catch (err) {
      throw new SerializationError(err.message);
    }
  }

  _deserialize (contents) {
    try {
      return TOML.parse(contents);
    } catch (err) {
      throw new SerializationError(err.message);
    }
  }

  _renderTemplate (template, data) {
    try {
      return maxstache(template, data);
    } catch (err) {
      throw new SerializationError(err.message);
    }
  }

  _sortObjectKeys (unsorted) {
    const sortedKeys = Object.keys(unsorted).sort()

    return sortedKeys.reduce((accum, key) => {
      accum[key] = unsorted[key]
      return accum
    }, {})
  }

  async _saveTreeToNewBranch({ treeHash, parentRef, branch, msg }) {
    const commitHash = await this.git.commitTree(treeHash, { // TODO: Wrap errors
      p: parentRef,
      m: msg,
    });
    await this.git.branch(branch, commitHash); // TODO: Wrap errors
  }

  async _saveTreeToExistingBranch ({ treeHash, branch, msg }) {
    const commitHash = await this.git.commitTree(treeHash, { // TODO: Wrap errors
      p: branch,
      m: msg,
    });
    const qualifiedBranch = await this._getQualifiedRef(branch);
    await this.git.updateRef(qualifiedBranch, commitHash); // TODO: Wrap errors
  }

  _getQualifiedRef (ref) {
    // TODO: Wrap errors
    return this.git.revParse({'symbolic-full-name': true}, ref);
  }
}
