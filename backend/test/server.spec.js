const request = require('supertest')
const fs = require('fs')
const { stripIndent } = require('common-tags')
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
const INVALID_GIT_DIR = './test/tmp/invalid-repo/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'
const SAMPLE_DATA_CHANGES_COUNT = 4

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

  test('starting server without valid git repo throws error', async () => {
    const localGitSheets = await GitSheets.create(INVALID_GIT_DIR)
    await expect(createServer(localGitSheets))
      .rejects
      .toThrow()
  })

  describe('config', () => {
    test('base endpoint returns config', async () => {
      const response = await request(server.callback())
        .get('/master')
        .expect(200)

      expect(response.body).toHaveProperty('config')
      expect(response.body.config).toHaveProperty('path')
      expect(response.body.config.path).toBe('{{id}}')
    })

    test('updates config', async () => {
      await request(server.callback())
        .put('/master')
        .send({ config: { path: '{{id}}-updated'} })
        .expect(204)

      const response = await request(server.callback())
        .get('/master')
      
      expect(response.body.config.path).toBe('{{id}}-updated')
    })
  })

  describe('list records', () => {
    test('lists rows with _id field in each row', async () => {
      await loadData(gitSheets, {
        data: sampleData, 
        ref: 'master',
        branch: 'master'
      })

      const response = await request(server.callback())
        .get('/master/records')
        .expect(200)

      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(getCsvRowCount(sampleData))
      expect(response.body[0]).toHaveProperty('_id')
    })

    test('returns empty array if no data', async () => {
      const response = await request(server.callback())
        .get('/master/records')
        .expect(200)

      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(0)
    })
    
    test('requesting invalid ref throws error', async () => {
      await request(server.callback())
        .get('/;echo%20hi/records')
        .expect(400)
    })

    test('requesting nonexistent ref throws 404', async () => {
      await request(server.callback())
        .get('/unicorns/records')
        .expect(404)
    })

    test.skip('requesting a non-gitsheet-style branch returns empty array with count in header', async () => {
      // commit a csv file (non exploded) and request the branch
      const response = await request(server.callback())
        .get('/master/records')
        .expect(200)

      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.lenegth).toBe(0)
      expect(response.header).toHaveProperty('X-GitSheets-Invalid-Items')
      expect(response.header['X-GitSheets-Invalid-Items']).toBe(1)
    })
  })

  describe('import', () => {
    test('creates commit on current branch with exploded data', async () => {
      await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleData)
        .expect(204)

      const treeItems = await getTreeItems(gitSheets, 'master')
      const expectedCount = getCsvRowCount(sampleData) + 1 // .gitsheets subtree
      expect(treeItems.length).toBe(expectedCount)
    })

    test('maintains existing config', async () => {
      await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleData)
        .expect(204)

      const response = await request(server.callback())
        .get('/master')
      
      expect(response.body.config).toHaveProperty('path')
      expect(response.body.config.path).toBe('{{id}}')
    })

    test('truncates and loads', async () => {
      await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleData)
        .expect(204)

      await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleDataChanged)
        .expect(204)

      const response = await request(server.callback())
        .get('/master/records')

      const DELETED_RECORD_ID = '5'
      const deletedRecord = response.body.find((record) => record.id === DELETED_RECORD_ID)
      expect(deletedRecord).not.toBeDefined()
    })

    test('creates commit on new branch when specified', async () => {
      await request(server.callback())
        .post('/master/import?branch=proposal')
        .type('csv')
        .send(sampleDataChanged)
        .expect(204)

      const treeItems = await getTreeItems(gitSheets, 'proposal')
      const expectedCount = getCsvRowCount(sampleDataChanged) + 1 // .gitsheets subtree
      expect(treeItems.length).toBe(expectedCount)
    })

    test('sending non-csv data throws an error', async () => {
      await request(server.callback())
        .post('/master/import')
        .send({ foo: 'bar' })
        .expect(415)
    })

    test.skip('omitting data throws an error', async () => {
      await request(server.callback())
        .post('/master/import')
        .expect(400)
    })

    test('sending malformed csv data throws an error', async () => {
      const malformedCsvData = stripIndent`
        id,username
        1"
        foo,"bar
      `
      await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(malformedCsvData)
        .expect(422)
    })

    test('importing onto nonexistent branch throws an error', async () => {
      await request(server.callback())
        .post('/unicorns/import')
        .type('csv')
        .send(sampleData)
        .expect(404)
    })

    test.skip('importing onto new branch throws an error', async () => {
      // create git dir without initial commit
    })

    // TODO: TOML parse errors, invalid path templates
  })

  describe('compare', () => {
    beforeEach(async () => {
      await loadData(gitSheets, {
        data: sampleData,
        ref: 'master',
        branch: 'master'
      })
      await loadData(gitSheets, {
        data: sampleDataChanged,
        ref: 'master',
        branch: 'proposal'
      })
    })

    test('returns expected number of diffs', async () => {
      const response = await request(server.callback())
        .get('/master/compare/proposal')
        .expect(200)
      
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(SAMPLE_DATA_CHANGES_COUNT)
    })

    test('computes expected json patch for modified row', async () => {
      const response = await request(server.callback())
        .get('/master/compare/proposal')

      const modifiedDiff = response.body.find((diff) => diff.status === 'modified')

      expect(modifiedDiff).toBeTruthy()
      expect(modifiedDiff.patch.length).toBe(1)

      const expectedPatch = {
        op: 'replace',
        path: '/last_name',
        from: 'Hansford',
        value: 'Footsford'
      }
      expect(modifiedDiff.patch[0]).toMatchObject(expectedPatch)
    })

    test('comparing identical refs returns empty array', async () => {
      const response = await request(server.callback())
        .get('/master/compare/master')

      expect(response.body.length).toBe(0)
    })

    test('merging merges branches', async () => {
      await request(server.callback())
        .post('/master/compare/proposal')
        .expect(204)

      const response = await request(server.callback())
        .get('/master/records')

      const changedRowId = '3'
      const changedRow = response.body.find((row) => row.id === changedRowId)
      expect(changedRow).toBeDefined()
      expect(changedRow.last_name).toBe('Footsford')
    })

    test('merging deletes merged branch', async () => {
      await request(server.callback())
        .post('/master/compare/proposal')
        .expect(204)

      await request(server.callback())
        .get('/proposal/records')
        .expect(404)
    })

    test('merging on non-ancestor throws error', async () => {
      const conflictingData = stripIndent`
        id,first_name,last_name,email,dob
        1,empty,empty,empty,empty
      `
      await loadData(gitSheets, {
        data: conflictingData,
        ref: 'master',
        branch: 'master'
      })

      await request(server.callback())
        .post('/master/compare/proposal')
        .expect(409)
    })
  })
})
