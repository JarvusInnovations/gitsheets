const { Repo, BlobObject } = require('hologit/lib')
const maxstache = require('maxstache')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const jsonpatch = require('fast-json-patch')

module.exports = class GitSheets {
  static async create(gitDir = null) {
    const repo = (gitDir)
      ? new Repo({ gitDir })
      : await Repo.getFromEnvironment()
    const git = await repo.getGit()

    return new GitSheets(repo, git)
  }

  constructor (repo, git) {
    this.repo = repo
    this.git = git
  }

  async checkIsValidRepo () {
    try {
      await this.git.status()
      return true
    } catch (err) {
      return false
    }
  }

  async getConfig (ref) {
    const tree = await this.repo.createTreeFromRef(ref)
    const child = await tree.getChild('.gitsheets/config')
    return child && this.parseBlob(child)
  }

  async saveConfig (config, ref = null) {
    const treeHash = await this.makeConfigTree(config, ref)
    await this.saveTreeToExistingBranch({
      treeHash,
      branch: ref,
      msg: 'save config'
    })
  }

  async makeConfigTree (config, ref = null) {
    const tomlConfig = TOML.stringify(config)
    const path = '.gitsheets/config'
    const tree = (ref)
      ? await this.repo.createTreeFromRef(ref)
      : this.repo.createTree()

    await tree.writeChild(path, tomlConfig)
    return tree.write()
  }

  async makeTreeFromCsv ({ readStream, pathTemplate, ref = null }) {
    const tree = this.repo.createTree()

    if (ref) {
      const srcTree = await this.repo.createTreeFromRef(ref)
      await tree.merge(srcTree, { files: ['.gitsheets/*'] })
    }

    return new Promise ((resolve, reject) => {
      const pendingWrites = []

      readStream
        .pipe(csvParser({ strict: true }))
        .on('data', (row) => {
          const tomlRow = TOML.stringify(sortKeys(row))
          const fileName = maxstache(pathTemplate, row)

          pendingWrites.push(tree.writeChild(fileName, tomlRow));
        })
        .on('end', async () => {
          await Promise.all(pendingWrites)

          tree.write()
            .then(resolve)
            .catch(reject);
        })
        .on('error', reject)
    })
  }

  async saveTreeToExistingBranch ({ treeHash, branch, msg = '' }) {
    const commitHash = await this.git.commitTree(treeHash, {
      p: branch,
      m: msg
    })
    const qualifiedBranch = await this.getQualifiedRef(branch)
    await this.git.updateRef(qualifiedBranch, commitHash)
  }

  async saveTreeToNewBranch ({ treeHash, parentRef, branch, msg = '' }) {
    const commitHash = await this.git.commitTree(treeHash, {
      p: parentRef,
      m: msg
    })
    await this.git.branch(branch, commitHash)
  }

  async getRows (ref) {
    const tree = (ref)
      ? await this.repo.createTreeFromRef(ref)
      : this.repo.createTree()

    const keyedChildren = await tree.getBlobMap()
    const rows = []
    for (let key in keyedChildren) {
      if (key.startsWith('.gitsheets/')) {
        continue;
      }

      const child = keyedChildren[key]
      if (child instanceof BlobObject) {
        const data = await this.parseBlob(child)
        data._id = key
        rows.push(data)
      }
    }
    return rows
  }

  async getDiffs (srcRef, dstRef) {
    const srcTree = await this.repo.createTreeFromRef(srcRef)
    const srcChildren = await srcTree.getBlobMap()

    const dstTree = await this.repo.createTreeFromRef(dstRef)
    const dstChildren = await dstTree.getBlobMap()

    const parsedDiffOutput = await this.getParsedDiffOutput(srcRef, dstRef)

    const pendingDiffs = parsedDiffOutput
      .filter((diff) => ['A', 'D', 'M', 'R'].includes(diff.status))
      .map(async (diff) => {
        const { status, path, newPath } = diff

        switch (status) {
          case 'A':
            return {
              _id: path,
              status: 'added',
              value:  await this.parseBlob(dstChildren[path])
            }
          case 'D':
            return {
              _id: path,
              status: 'removed',
              value: await this.parseBlob(srcChildren[path])
            }
          case 'M': {
            const src = await this.parseBlob(srcChildren[path])
            const dst = await this.parseBlob(dstChildren[path])
            return {
              _id: path,
              status: 'modified',
              patch: this.compareObjects(src, dst)
            }
          }
          case 'R': {
            const src = await this.parseBlob(srcChildren[path])
            const dst = await this.parseBlob(dstChildren[newPath])
            return {
              _id: path,
              status: 'modified',
              patch: this.compareObjects(src, dst)
            }
          }
        }
      })

    return Promise.all(pendingDiffs)
  }

  async merge (srcRef, dstRef) {
    try {
      await this.git.mergeBase({'is-ancestor': true}, srcRef, dstRef)
    } catch (err) {
      throw new Error(`${srcRef} is not an ancestor of ${dstRef}`)
    }
    const qualifiedSrcRef = await this.getQualifiedRef(srcRef)
    const qualifiedDstRef = await this.getQualifiedRef(dstRef)
    await this.git.updateRef(qualifiedSrcRef, qualifiedDstRef)
    await this.git.branch({'d': true}, dstRef)
  }

  async getParsedDiffOutput (srcRef, dstRef) {
    const diffOutput = await this.git.diff({'name-status': true}, srcRef, dstRef)
    const diffs = diffOutput
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [ status, path, newPath ] = line.split('\t')
        return {
          status: status.charAt(0), // remove any score
          path,
          newPath
        }
      })
    return diffs
  }

  async parseBlob (blob) {
    const contents = await blob.read()
    return TOML.parse(contents)
  }

  compareObjects (src, dst) {
    const includeTestOps = true
    const ops = jsonpatch.compare(src, dst, includeTestOps)
    return this.mergeTestAndReplaceOps(ops)
  }

  mergeTestAndReplaceOps (items) {
    const mergeableItems = items.map((item) => {
      if (item.op === 'test') return { path: item.path, from: item.value }
      else return item
    })
    const keyedItems = mergeableItems.reduce((accum, item) => {
      if (accum.has(item.path)) {
        const currentItem = accum.get(item.path)
        accum.set(item.path, { ...currentItem, ...item })
      } else {
        accum.set(item.path, item)
      }
      return accum
    }, new Map())

    return Array.from(keyedItems.values())
  }

  getQualifiedRef (ref) {
    return this.git.revParse({'symbolic-full-name': true}, ref)
  }
}

function sortKeys (unsorted) {
  const sorted = {}

  Object
    .keys(unsorted)
    .sort()
    .forEach((key) => sorted[key] = unsorted[key])

  return sorted
}
