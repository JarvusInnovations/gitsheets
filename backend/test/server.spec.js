const request = require('supertest')
const del = require('del')
const fs = require('fs')
const execa = require('execa')
const git = require('git-client')
const toReadableStream = require('to-readable-stream')
const createServer = require('../server')
const { explode } = require('../lib')

const TEST_GIT_DIR = './test/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'

describe('server', () => {
  let server
  let sampleData
  let sampleDataChanged

  beforeAll(() => {
    process.env.GIT_DIR = TEST_GIT_DIR
    sampleData = fs.readFileSync(SAMPLE_DATA).toString()
    sampleDataChanged = fs.readFileSync(SAMPLE_DATA_CHANGED).toString()
  })

  beforeEach(async () => {
    await setupRepo()
    server = await createServer()
  })

  afterEach(async () => {
    await teardownRepo()
  })

  test('lists rows', async () => {
    await loadData(sampleData)

    const response = await request(server.callback())
      .get('/master')
      .expect(200)

    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body.length).toBe(getCsvRowCount(sampleData))
  })

  describe('import', () => {
    test('creates a proposal branch with exploded data', async () => {
      const response = await request(server.callback())
        .post('/master/import?filenameTemplate={{id}}')
        .type('csv')
        .send(sampleDataChanged)
        .expect(200)

      expect(response.body).toHaveProperty('branch')
      const branch = response.body.branch
      expect(branch).toMatch('pr-')

      const { stdout } = await execa('git', ['ls-tree', branch])
      const lines = stdout.split('\n')
      expect(lines.length).toBe(getCsvRowCount(sampleDataChanged))
    })

    test('omitting filenameTemplate throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleDataChanged)
        .expect(400)
    })

    test('sending non-csv data throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import?filenameTemplate={{id}}')
        .send({ foo: 'bar' })
        .expect(400)
    })

    test.skip('omitting data throws an error', async () => {
      const response = await request(server.callback())
        .post('/master/import?filenameTemplate={{id}}')
        .expect(400)
    })
  })
})

async function setupRepo () {
  await git.init()
  await git.commit({
    'allow-empty': true,
    'allow-empty-message': true,
    m: ''
  })
}

async function teardownRepo () {
  await del([TEST_GIT_DIR])
}

async function loadData (data) {
  const fileStream = toReadableStream(data)
  const filenameTemplate = '{{id}}'
  const treeHash = await explode({ fileStream, filenameTemplate })
  const commitHash = await git.commitTree(treeHash, {
    p: 'HEAD',
    m: 'sample data'
  })
  await git.updateRef('HEAD', commitHash)
}

function getCsvRowCount (string) {
  return string
    .split('\n')
    .filter((line) => line.length > 0)
    .length - 1
}
