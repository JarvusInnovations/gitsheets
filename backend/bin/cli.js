const yargs = require('yargs')

const argv = yargs
  .version(require('../package.json').version)
  .commandDir('../commands')
  .demandCommand()
  .argv
