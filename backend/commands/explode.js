const fs = require('fs')
const path = require('path')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const makeDir = require('make-dir')

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
    describe: 'Field name to use as the file name',
    demand: true
  }
}

exports.handler = async function explode ({ file, outputDir, filenameTemplate }) {
  await makeDir(outputDir)

  fs.createReadStream(file)
    .pipe(csvParser())
    .on('data', async (row) => {
      const tomlRow = TOML.stringify(sortKeys(row))

      const filename = row[filenameTemplate]
      if (!filename) throw new Error('Row missing value for --filename-template')
      const filepath = path.resolve(outputDir, filename)

      await fs.promises.writeFile(filepath, tomlRow) // TODO: sub for stable api
    })
}

function sortKeys (unsorted) {
  const sorted = {}
  Object.keys(unsorted).sort().forEach((key) => sorted[key] = unsorted[key])
  return sorted
}
