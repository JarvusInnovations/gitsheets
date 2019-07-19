const fs = require('fs')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const handlebars = require('handlebars')
const { Repo, TreeObject } = require('hologit/lib')

exports.command = 'explode <file>'
exports.desc = 'Create a TOML file for every row of a CSV <file>'

exports.builder = {
  'filename-template': {
    alias: 'ft',
    describe: 'Handlebars template to construct each file name. e.g. "{{id}}"',
    demand: true
  }
}

exports.handler = async function explode ({ file, filenameTemplate }) {
  const renderFilename = handlebars.compile(filenameTemplate)

  const repo = await Repo.getFromEnvironment()
  const treeObject = new TreeObject(repo)

  const pendingWriteChilds = []

  fs.createReadStream(file)
    .pipe(csvParser())
    .on('data', async (row) => {
      const tomlRow = TOML.stringify(sortKeys(row))
      const fileName = renderFilename(row)

      pendingWriteChilds.push(treeObject.writeChild(fileName, tomlRow))
    })
    .on('end', async () => {
      await Promise.all(pendingWriteChilds)
      const hash = await treeObject.write()
      console.log(hash)
    })
}

function sortKeys (unsorted) {
  const sorted = {}
  Object.keys(unsorted).sort().forEach((key) => sorted[key] = unsorted[key])
  return sorted
}
