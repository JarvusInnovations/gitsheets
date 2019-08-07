const toReadableStream = require('to-readable-stream')
const del = require('del')
const makeDir = require('make-dir')
const { explode } = require('../../lib')

module.exports = {
  setupRepo,
  teardownRepo,
  loadData,
  getCsvRowCount,
  getTreeItems
}

async function setupRepo (gitSheets) {
  const gitDir = gitSheets.repo.gitDir
  await makeDir(gitDir)
  await gitSheets.git.init()
  await gitSheets.git.commit({
    'allow-empty': true,
    'allow-empty-message': true,
    m: ''
  })
}

async function teardownRepo (gitSheets) {
  const gitDir = gitSheets.repo.gitDir
  await del([gitDir])
}

async function loadData (gitSheets, data, pathTemplate) {
  const readStream = toReadableStream(data)
  const treeHash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate })
  await gitSheets.saveTreeToExistingBranch({
    treeHash,
    branch: 'master',
    msg: 'sample data'
  })
}

function getCsvRowCount (string) {
  return string
    .split('\n')
    .filter((line) => line.length > 0)
    .length - 1
}

async function getTreeItems (gitSheets, branch) {
  const output = await gitSheets.git.lsTree(branch)
  return output.split('\n')
}
