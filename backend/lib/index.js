const { Repo } = require('hologit/lib')
const handlebars = require('handlebars')
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

  async makeTreeFromCsv ({ readStream, pathTemplate, ref }) {
    const renderPath = handlebars.compile(pathTemplate)
    const tree = (ref)
      ? await this.repo.createTreeFromRef(ref)
      : this.repo.createTree()

    return new Promise ((resolve, reject) => {
      const pendingWrites = []

      readStream
        .pipe(csvParser({ strict: true }))
        .on('data', (row) => {
          const tomlRow = TOML.stringify(sortKeys(row))
          const fileName = renderPath(row)

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
    await this.git.updateRef(branch, commitHash)
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

    const keyedChildren = await tree.getChildren() // results are on __proto__
    const rows = []
    for (let key in keyedChildren) {
      const child = keyedChildren[key]
      const data = await this.parseBlob(child)
      data._id = key
      rows.push(data)
    }
    return rows
  }

  async getDiffs (srcRef, dstRef) {
    const srcTree = await this.repo.createTreeFromRef(srcRef)
    const srcChildren = await srcTree.getChildren()

    const dstTree = await this.repo.createTreeFromRef(dstRef)
    const dstChildren = await dstTree.getChildren()

    const parsedDiffOutput = await this.getParsedDiffOutput(srcRef, dstRef)

    const pendingDiffs = parsedDiffOutput.map(async (diff) => {
      switch (diff.status) {
        case 'A':
          return {
            _id: diff.file,
            status: 'added',
            value:  await this.parseBlob(dstChildren[diff.file])
          }
        case 'D':
          return {
            _id: diff.file,
            status: 'removed',
            value: await this.parseBlob(srcChildren[diff.file])
          }
        case 'M':
          const src = await this.parseBlob(srcChildren[diff.file])
          const dst = await this.parseBlob(dstChildren[diff.file])
          return {
            _id: diff.file,
            status: 'modified',
            value: jsonpatch.compare(src, dst)
          }
      }
    })

    return Promise.all(pendingDiffs)
  }

  async getParsedDiffOutput (srcRef, dstRef) {
    const diffOutput = await this.git.diff({'name-status': true}, srcRef, dstRef)
    const diffs = diffOutput
      .split('\n')
      .map((line) => {
        const [ status, file ] = line.split('\t')
        return { status, file }
      })
    return diffs
  }

  async parseBlob (blob) {
    const contents = await blob.read()
    return TOML.parse(contents)
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
