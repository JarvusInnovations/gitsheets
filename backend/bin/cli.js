const yargs = require('yargs')

const argv = yargs
  .commandDir('../commands')
  .demandCommand()
  .argv
