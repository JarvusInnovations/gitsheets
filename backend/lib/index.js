const { Repo } = require('hologit/lib')
const handlebars = require('handlebars')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')

module.exports = class GitSheets {
  static async create(gitDir) {
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

  async makeTreeFromCsv ({ readStream, pathTemplate, ref }) {
    const renderPath = handlebars.compile(pathTemplate)
    const tree = (ref)
      ? await this.repo.createTreeFromRef(ref)
      : this.repo.createTree()

    return new Promise ((resolve, reject) => {
      const pendingWrites = []

      readStream
        .pipe(csvParser())
        .on('data', async (row) => {
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
      const contents = await child.read()
      const data = TOML.parse(contents)
      rows.push(data)
    }
    return rows
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
