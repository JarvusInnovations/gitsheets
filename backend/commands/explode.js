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

exports.handler = async function handler ({ file, filenameTemplate }) {
  const fileStream = fs.createReadStream(file)
  const hash = await explode({ fileStream, filenameTemplate })
  console.log(hash)
}

exports.explode = explode

async function explode ({ fileStream, filenameTemplate }) {
  const renderFilename = handlebars.compile(filenameTemplate)

  const repo = await Repo.getFromEnvironment()
  const treeObject = new TreeObject(repo)

  return new Promise ((resolve, reject) => {
    const pendingWrites = []

    fileStream
      .pipe(csvParser())
      .on('data', async (row) => {
        const tomlRow = TOML.stringify(sortKeys(row))
        const fileName = renderFilename(row)

        pendingWrites.push(treeObject.writeChild(fileName, tomlRow))
      })
      .on('end', async () => {
        await Promise.all(pendingWrites)
        resolve(treeObject.write()) // resolves to hash
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
