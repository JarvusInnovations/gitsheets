const toReadableStream = require('to-readable-stream')
const { stripIndent } = require('common-tags')
const GitSheets = require('../lib')
const { setupRepo, teardownRepo } = require('./util')

const csv = stripIndent`
  id,first_name,last_name
  1,Ada,Lovelace
  2,Grace,Hopper
  3,Radia,Perlman
`
const expectedHash = 'fb070046498551bb49ce253ef13daddcb56949c1'
const TEST_GIT_DIR = './test/tmp/lib-test-repo/.git'

describe('explode', () => {
  beforeEach(async () => {
    gitSheets = await GitSheets.create(TEST_GIT_DIR)
    await setupRepo(gitSheets)
  })

  afterEach(async () => {
    await teardownRepo(gitSheets)
  })

  test('returns expected tree hash', async () => {
    const readStream = toReadableStream(csv)
    const pathTemplate = '{{id}}'
    const hash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate })
    expect(hash).toBe(expectedHash)
  })
})

