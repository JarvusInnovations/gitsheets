const fs = require('fs')
const { explode } = require('../lib')

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
