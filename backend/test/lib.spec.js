const fs = require('fs')
const toReadableStream = require('to-readable-stream')
const { stripIndent } = require('common-tags')
const GitSheets = require('../lib')
const { setupRepo, teardownRepo, loadData } = require('./util')

const csv = stripIndent`
  id,first_name,last_name
  1,Ada,Lovelace
  2,Grace,Hopper
  3,Radia,Perlman
`
const expectedHash = 'e9f02749cb91f919f25a3c55899ded04f63a7b1b'
const TEST_GIT_DIR = './test/tmp/lib-test-repo/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'
const SAMPLE_DATA_CHANGES_COUNT = 4

describe('lib', () => {
  let gitSheets
  let sampleData
  let sampleDataChanged

  beforeAll(() => {
    sampleData = fs.readFileSync(SAMPLE_DATA).toString()
    sampleDataChanged = fs.readFileSync(SAMPLE_DATA_CHANGED).toString()
  })

  beforeEach(async () => {
    gitSheets = await GitSheets.create(TEST_GIT_DIR)
    await setupRepo(gitSheets)
  })

  afterEach(async () => {
    await teardownRepo(gitSheets)
  })

  test('makeTreeFromCsv returns expected tree hash', async () => {
    const readStream = toReadableStream(csv)
    const pathTemplate = '{{id}}'
    const ref = 'master'
    const hash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate, ref })
    expect(hash).toBe(expectedHash)
  })

  test('getDiffs returns expected number of diffs', async () => {
    await loadData(gitSheets, {
      data: sampleData,
      pathTemplate: '{{id}}',
      ref: 'master',
      branch: 'master'
    })
    await loadData(gitSheets, {
      data: sampleDataChanged,
      pathTemplate: '{{id}}',
      ref: 'master',
      branch: 'proposal'
    })

    const diffs = await gitSheets.getDiffs('master', 'proposal')
    expect(diffs.length).toBe(SAMPLE_DATA_CHANGES_COUNT)
  })

  test('path templates support spaces in variable names', async () => {
    const data = stripIndent`
      First Name,Last Name
      Ada,Lovelace
      Grace,Hopper
      Radia,Perlman
    `
    await loadData(gitSheets, {
      data,
      pathTemplate: '{{Last Name}}',
      ref: 'master',
      branch: 'master'
    })
  })
})

