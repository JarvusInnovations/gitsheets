const makeDir = require('make-dir');
const del = require('del');
const request = require('supertest')
const fs = require('fs')
const { stripIndent } = require('common-tags')
const intoStream = require('into-stream');
const GitSheets = require('../lib/GitSheets')
const createServer = require('../server')

const GIT_DIR = './test/tmp/server-test-repo/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'
const SAMPLE_DATA_CHANGES_COUNT = 4

describe('Server', () => {
  let gitSheets
  let server
  let sampleData
  let sampleDataChanged

  beforeAll(async () => {
    sampleData = fs.readFileSync(SAMPLE_DATA).toString()
    sampleDataChanged = fs.readFileSync(SAMPLE_DATA_CHANGED).toString()

    gitSheets = await GitSheets.create(GIT_DIR)

    // Stateful helper functions
    importFixture = (fixture, branch) => gitSheets.import({
      data: intoStream.object(fixture),
      dataType: 'csv',
      parentRef: 'master',
      saveToBranch: branch,
    });
  })

  beforeEach(async () => {
    await makeDir(GIT_DIR);
    await gitSheets.git.init();
    await gitSheets.git.commit({
      m: 'init',
      'allow-empty': true,
    });

    server = await createServer(gitSheets)
  })

  afterEach(async () => {
    await del([GIT_DIR]);
  })

  describe('Config', () => {
    test('base endpoint returns config', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      const response = await request(server.callback())
        .get('/config/master')
        .expect(200)

      expect(response.body).toHaveProperty('config')
      expect(response.body.config).toHaveProperty('path')
      expect(response.body.config.path).toBe('{{id}}')
    })

    test('updates config', async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');

      await request(server.callback())
        .put('/config/master')
        .send({ config: { path: '{{last_name}}/{{first_name}}'} })
        .expect(204)

      const response = await request(server.callback())
        .get('/config/master')

      expect(response.body.config.path).toBe('{{last_name}}/{{first_name}}')
    })
  })

  describe('Import', () => {
    beforeEach(async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
    })

    test('returns expected status on success', async () => {
      await request(server.callback())
        .post('/import/master')
        .send(sampleData)
        .type('csv')
        .expect(204)
    })

    test('sending non-csv data throws an error', async () => {
      await request(server.callback())
        .post('/import/master')
        .send({ foo: 'bar' })
        .expect(415)
    })

    test.skip('omitting data throws an error', async () => {
      await request(server.callback())
        .post('/import/master')
        .expect(400)
    })

    test('sending malformed csv data throws an error', async () => {
      const malformedCsvData = stripIndent`
        id,username
        1"
        foo,"bar
      `
      await request(server.callback())
        .post('/import/master')
        .type('csv')
        .send(malformedCsvData)
        .expect(422)
    })

    test('importing onto nonexistent branch throws an error', async () => {
      await request(server.callback())
        .post('/import/unicorns')
        .type('csv')
        .send(sampleData)
        .expect(404)
    })
  })

  describe('Export', () => {
    beforeEach(async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
    })

    test('returns array of objects', async () => {
      await importFixture(sampleData, 'master');

      const response = await request(server.callback())
        .get('/records/master')
        .expect(200)

      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(getCsvRowCount(sampleData))
      expect(response.body[0]).toHaveProperty('_path')
    })

    test('requesting invalid ref throws error', async () => {
      await request(server.callback())
        .get('/records/;echo%20hi')
        .expect(400)
    })

    test('requesting nonexistent ref throws 404', async () => {
      await request(server.callback())
        .get('/records/unicorns')
        .expect(404)
    })

    test('lists rows as csv if requested', async () => {
      await importFixture(sampleData, 'master');

      const response = await request(server.callback())
        .get('/records/master')
        .accept('text/csv')
        .expect(200)

      expect(getCsvRowCount(response.text)).toBe(getCsvRowCount(sampleData))
      expect(response.type).toBe('text/csv')
      expect(response.headers).toHaveProperty('content-disposition')
    })
  })

  describe('Compare', () => {
    beforeEach(async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
    })

    test('returns expected number of diffs', async () => {
      await importFixture(sampleData, 'master');
      await importFixture(sampleDataChanged, 'proposal');

      const response = await request(server.callback())
        .get('/compare/master..proposal')
        .expect(200)

      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBe(SAMPLE_DATA_CHANGES_COUNT)
    })

    test('supports nested branch names', async () => {
      await importFixture(sampleData, 'proposal/alpha');
      await importFixture(sampleDataChanged, 'proposal/beta');


      await request(server.callback())
        .get('/compare/proposal/alpha..proposal/beta')
        .expect(200)
    })
  })

  describe('Merge', () => {
    beforeEach(async () => {
      await gitSheets.setConfigItem('master', 'path', '{{id}}');
    })

    test('merging merges branches', async () => {
      await importFixture(sampleData, 'master');
      await importFixture(sampleDataChanged, 'proposal');

      await request(server.callback())
        .post('/compare/master..proposal')
        .expect(204)

      const response = await request(server.callback())
        .get('/records/master')

      const changedRowId = '3'
      const changedRow = response.body.find((row) => row.id === changedRowId)
      expect(changedRow).toBeDefined()
      expect(changedRow.last_name).toBe('Footsford')
    })

    test('supports nested branch names', async () => {
      await importFixture(sampleData, 'proposal/alpha');
      await gitSheets.import({
        data: intoStream.object(sampleDataChanged),
        dataType: 'csv',
        parentRef: 'proposal/alpha',
        saveToBranch: 'proposal/beta',
      })

      await request(server.callback())
        .post('/compare/proposal/alpha..proposal/beta')
        .expect(204)
    })
  })
})

function getCsvRowCount (string) {
  return string
    .split('\n')
    .filter((line) => line.length > 0)
    .length - 1
}
