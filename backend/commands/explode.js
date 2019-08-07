const fs = require('fs')
const GitSheets = require('../lib')

exports.command = 'explode <file>'
exports.desc = 'Create a TOML file for every row of a CSV <file>'

exports.builder = {
  'path-template': {
    alias: 'path',
    describe: 'Handlebars template to construct each file name. e.g. "{{id}}"',
    demand: true
  }
}

exports.handler = async function handler ({ file, pathTemplate }) {
  const readStream = fs.createReadStream(file)
  const gitSheets = await GitSheets.create()
  const hash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate })
  console.log(hash)
}
