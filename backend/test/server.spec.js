const request = require('supertest')
const fs = require('fs')
const GitSheets = require('../lib')
const createServer = require('../server')
const {
  setupRepo,
  teardownRepo,
  loadData,
  getCsvRowCount,
  getTreeItems
} = require('./util')

const TEST_GIT_DIR = './test/tmp/server-test-repo/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'

describe('server', () => {
  let gitSheets
  let server
  let sampleData
  let sampleDataChanged

  beforeAll(() => {
    sampleData = fs.readFileSync(SAMPLE_DATA).toString()
    sampleDataChanged = fs.readFileSync(SAMPLE_DATA_CHANGED).toString()
  })

  beforeEach(async () => {
    gitSheets = await GitSheets.create(TEST_GIT_DIR)
    await setupRepo(gitSheets)
    server = await createServer(gitSheets)
  })

  afterEach(async () => {
    await teardownRepo(gitSheets)
  })

  test('lists rows', async () => {
    await loadData(gitSheets, sampleData, '{{id}}')

    const response = await request(server.callback())
      .get('/master')
      .expect(200)

    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body.length).toBe(getCsvRowCount(sampleData))
  })

  describe('import', () => {
    test('creates commit on current branch with exploded data', async () => {
      const response = await request(server.callback())
        .post('/master/import?path={{id}}')
        .type('csv')
        .send(sampleData)
        .expect(204)

      const treeItems = await getTreeItems(gitSheets, 'master')
      expect(treeItems.length).toBe(getCsvRowCount(sampleData))
    })

    test('creates commit on new branch when specified', async () => {
      const response = await request(server.callback())
        .post('/master/import?path={{id}}&branch=proposal')
        .type('csv')
        .send(sampleDataChanged)
        .expect(204)

      const treeItems = await getTreeItems(gitSheets, 'proposal')
      expect(treeItems.length).toBe(getCsvRowCount(sampleDataChanged))
    })

    test('omitting path throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleDataChanged)
        .expect(400)
    })

    test('sending non-csv data throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import?path={{id}}')
        .send({ foo: 'bar' })
        .expect(400)
    })

    test.skip('omitting data throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import?path={{id}}')
        .expect(400)
    })
  })
})
