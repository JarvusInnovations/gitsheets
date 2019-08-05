const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const handlebars = require('handlebars')
const { Repo } = require('hologit/lib')
const git = require('git-client')

module.exports = {
  explode,
  listRows
}

async function explode ({ fileStream, filenameTemplate }) {
  const renderFilename = handlebars.compile(filenameTemplate)
  const repo = await Repo.getFromEnvironment();
  const tree = repo.createTree();

  return new Promise ((resolve, reject) => {
    const pendingWrites = []

    fileStream
      .pipe(csvParser())
      .on('data', async (row) => {
        const tomlRow = TOML.stringify(sortKeys(row))
        const fileName = renderFilename(row)

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

function sortKeys (unsorted) {
  const sorted = {}

  Object
    .keys(unsorted)
    .sort()
    .forEach((key) => sorted[key] = unsorted[key])

  return sorted
}

async function listRows (ref) {
  const repo = await Repo.getFromEnvironment()
  const treeObject = await repo.createTreeFromRef(ref)
  const keyedChildren = await treeObject.getChildren()
  const rows = []
  for (let key in keyedChildren) {
    const child = keyedChildren[key]
    const contents = await child.read()
    const data = TOML.parse(contents)
    rows.push(data) // We could alternatively stream JSON LD here
  }
  return rows
}
