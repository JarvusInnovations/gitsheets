const { Repo, BlobObject } = require('hologit/lib');
const { Readable } = require('stream');
const TOML = require('@iarna/toml');
const maxstache = require('maxstache');
const jsonpatch = require('fast-json-patch');
const csvParser = require('csv-parser');

const {
  SerializationError,
  ConfigError,
  InvalidRefError,
  MergeError,
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
    this.version = 2;
  }

  /**
   * Get config object from .gitsheets/config on a particular ref
   * @public
   * @param {string} ref - Ref of tree (e.g. master)
   * @return {Promise<Object>}
   * @throws {ConfigError}
   */
  async getConfig (ref) {
    const tree = await this._createTreeFromRef(ref);
    const child = await tree.getChild('.gitsheets/config'); // TODO: Wrap errors
    if (!child) return {};

    const contents = await child.read(); // TODO: Wrap errors
    return this._deserialize(contents);
  }

  /**
   * Get a specific property from the config object
   * @public
   * @param {string} ref - Ref of tree (e.g. master)
   * @param {string} key - Top-level property name (e.g. path)
   * @return {Promise<*>}
   * @throws {ConfigError}
   */
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
   * @param {string} ref - Ref of parent tree (e.g. master)
   * @param {Object} config - Config object to save
   * @return {Promise<void>}
   * @throws {ConfigError}
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

  /**
   * Save a specific config property. Merges with existing config, if any.
   * @public
   * @param {string} ref - Ref of parent tree (e.g. master)
   * @param {string} key - Top-level property name (e.g. path)
   * @param {*} value - Value to set
   * @return {Promise<void>}
   * @throws {ConfigError}
   */
  async setConfigItem (ref, key, value) {
    const config = await this.getConfig(ref);
    const newConfig = { ...config, [key]: value };
    await this.setConfig(ref, newConfig);
  }

  /**
   * Serialise a dataset and commit it onto current or new branch
   * @public
   * @param {Object} opts
   * @param {Readable} opts.data - Stream of data to be imported
   * @param {string} [opts.dataType] - Type of input data (valid: csv)
   * @param {string} opts.parentRef - Ref of parent tree
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

  /**
   * Deserialize a dataset from a particular ref
   * @public
   * @param {string} ref - Ref of tree (e.g. master)
   * @returns {Promise<Readable>}
   */
  async export (ref) {
    const treeObject = await this._createTreeFromRef(ref);

    const blobMap = await treeObject.getBlobMap();
    let blobsRemaining = Object.entries(blobMap)
      .filter(this._isDataBlob)

    const deserialize = this._deserialize.bind(this);
    return new Readable({
      objectMode: true,
      async read () {
        if (blobsRemaining.length > 0) {
          const [key, blob] = blobsRemaining.shift() // mutates array
          this.push(
            await blob.read()
              .then(deserialize)
              .then((data) => ({ ...data, _path: key.substr(0, key.length-5) }))
          );
        } else {
          this.push(null);
        }
      },
    })
  }

  /**
   * Compare a dataset between two refs and return the diffs
   * @public
   * @param {string} srcRef - Ref of original state (e.g. master)
   * @param {string} dstRef - Ref of new state (e.g. proposal)
   * @returns {Promise<Array>}
   */
  async compare (srcRef, dstRef) {
    const [srcBlobMap, dstBlobMap] = await Promise.all([
      this._getBlobMapFromRef(srcRef),
      this._getBlobMapFromRef(dstRef),
    ]);

    const diffs = await this._getDiffs(srcRef, dstRef);

    const fullDiffs = diffs.map(({ status, path, newPath }) => ({
      added: async () => ({
        _path: path,
        status,
        value: await this._parseBlob(dstBlobMap[path]),
      }),
      deleted: async () => ({
        _path: path,
        status,
        value: await this._parseBlob(srcBlobMap[path]),
      }),
      modified: async () => ({
        _path: path,
        status,
        patch: await this._generatePatch(srcBlobMap[path], dstBlobMap[path]),
      }),
      renamed: async () => ({
        _path: path,
        status: 'modified',
        patch: await this._generatePatch(srcBlobMap[path], dstBlobMap[newPath]),
      }),
    }[status]()));

    return Promise.all(fullDiffs);
  }

  /**
   * Create a merge commit between two refs and update srcRef to point to it
   * Note: Only works if srcRef is ancestor of dstRef
   * Note: Force deletes dstRef
   * @public
   * @param {string} srcRef - Ref of original state (e.g. master)
   * @param {string} dstRef - Ref of new state (e.g. proposal)
   * @param {string} [msg=Merge <dstRef>] - Message of merge commit
   * @returns {Promise<void>}
   * @throws {MergeError}
   */
  async merge (srcRef, dstRef, msg = null) {
    await this._verifyIsAncestor(srcRef, dstRef);
    const commitMsg = msg || `Merge ${dstRef}`;

    const [
      qualifiedSrcRef,
      srcCommitHash,
      dstCommitHash,
      dstTreeHash,
    ] = await Promise.all([
      this._getQualifiedRef(srcRef),
      this._getCommitHash(srcRef),
      this._getCommitHash(dstRef),
      this._getTreeHash(dstRef),
    ]);

    const mergeCommitHash = await this.git.commitTree(dstTreeHash, {
      p: [ srcCommitHash, dstCommitHash ],
      m: commitMsg,
    });

    // TODO: Wrap errors
    await this.git.updateRef(qualifiedSrcRef, mergeCommitHash, srcCommitHash);
    await this.git.branch({D: true}, dstRef); // force delete in case srcRef is not checked out
  }

  _isDataBlob ([key, blob]) {
    return !key.startsWith('.gitsheets/') && key.endsWith('.toml') && blob instanceof BlobObject;
  }

  async _verifyIsAncestor (srcRef, dstRef) {
    try {
      await this.git.mergeBase({'is-ancestor': true}, srcRef, dstRef);
    } catch (err) {
      throw new MergeError(`${srcRef} is not an ancestor of ${dstRef}`);
    }
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
      .filter((line) => line.length > 0)
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
    return this._mergeTestAndReplaceOps(ops);
  }

  _mergeTestAndReplaceOps (items) {
    const mergeableItems = items.map((item) => {
      if (item.op === 'test') return { path: item.path, from: item.value };
      else return item;
    })
    const keyedItems = mergeableItems.reduce((accum, item) => {
      if (accum.has(item.path)) {
        const currentItem = accum.get(item.path);
        accum.set(item.path, { ...currentItem, ...item });
      } else {
        accum.set(item.path, item);
      }
      return accum;
    }, new Map());

    return Array.from(keyedItems.values());
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

          pendingWrites.push(treeObject.writeChild(`${path}.toml`, contents));
        })
        .on('end', () => {
          Promise.all(pendingWrites)
            .then(() => treeObject.write())
            .then(resolve)
            .catch(reject);
        })
        .on('error', (err) => {
          reject(new SerializationError(err.message))
        })
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

  _getCommitHash (ref) {
    return this.git.revParse({verify: true}, ref);
  }

  async _getTreeHash (ref) {
    const tree = await this._createTreeFromRef(ref);
    const hash = await tree.getHash();
    return hash
  }
}
