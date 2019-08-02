const fs = require('fs')
const csvParser = require('csv-parser')
const TOML = require('@iarna/toml')
const handlebars = require('handlebars')
const execa = require('execa')
const toReadableStream = require('to-readable-stream')

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

  return new Promise ((resolve, reject) => {
    const pendingWrites = []

    fileStream
      .pipe(csvParser())
      .on('data', (row) => {
        const fileName = renderFilename(row)
        const tomlRow = TOML.stringify(sortKeys(row))
        const input = toReadableStream(tomlRow)

        const subprocess = execa('git', ['hash-object', '-w', '--stdin'], { input })
        pendingWrites.push(subprocess.then(({ stdout }) => {
          return { fileName, hash: stdout }
        }))
      })
      .on('end', async () => {
        const objects = await Promise.all(pendingWrites)
        const tree = createTreeOfBlobs(objects)
        const input = toReadableStream(tree)

        const subprocess = execa('git', ['mktree'], { input })
        const { stdout } = await subprocess
        resolve(stdout)
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

function createTreeOfBlobs (objects) {
  const mode = '100644'
  const type = 'blob'
  return objects
    .filter((object) => object.hash.length > 0) // HOTFIX: Fixes race condition from captureOutputTrimmed
    .map((object) => `${mode} ${type} ${object.hash}\t${object.fileName}`)
    .join('\n') + '\n'
}
