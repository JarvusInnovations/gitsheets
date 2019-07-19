const fs = require('fs')
const path = require('path')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const makeDir = require('make-dir')
const handlebars = require('handlebars')

exports.command = 'explode <file>'
exports.desc = 'Create a TOML file for every row of a CSV <file>'

exports.builder = {
  'output-dir': {
    alias: 'o',
    describe: 'Directory to write TOML files to',
    demand: true
  },
  'filename-template': {
    alias: 'ft',
    describe: 'Handlebars template to construct each file name. e.g. "{{id}}"',
    demand: true
  }
}

exports.handler = async function explode ({ file, outputDir, filenameTemplate }) {
  await makeDir(outputDir)
  const renderFilename = handlebars.compile(filenameTemplate)

  fs.createReadStream(file)
    .pipe(csvParser())
    .on('data', async (row) => {
      const tomlRow = TOML.stringify(sortKeys(row))
      const filename = renderFilename(row)
      const filepath = path.resolve(outputDir, filename)

      await fs.promises.writeFile(filepath, tomlRow) // TODO: sub for stable api
    })
}

function sortKeys (unsorted) {
  const sorted = {}
  Object.keys(unsorted).sort().forEach((key) => sorted[key] = unsorted[key])
  return sorted
}
