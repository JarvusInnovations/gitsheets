const request = require('supertest')
const del = require('del')
const fs = require('fs')
const execa = require('execa')
const git = require('git-client')
const createServer = require('../server')
const { explode } = require('../lib')

const TEST_GIT_DIR = './test/.git'
const SAMPLE_DATA = './test/fixtures/sample_data.csv'
const SAMPLE_DATA_CHANGED = './test/fixtures/sample_data_changed.csv'
const SAMPLE_DATA_ROW_COUNT = 10

describe('server', () => {
  let server

  beforeAll(() => {
    process.env.GIT_DIR = TEST_GIT_DIR
  })

  beforeEach(async () => {
    await setupRepo()
    server = await createServer()
  })

  afterEach(async () => {
    await teardownRepo()
  })

  test('lists rows', async () => {
    await loadSampleData()

    const response = await request(server.callback())
      .get('/master')
      .expect(200)

    expect(Array.isArray(response.body)).toBe(true)
    expect(response.body.length).toBe(SAMPLE_DATA_ROW_COUNT)
  })

  describe('import', () => {
    test('creates a proposal branch with exploded data', async () => {
      const sampleData = fs.readFileSync(SAMPLE_DATA_CHANGED)

      const response = await request(server.callback())
        .post('/master/import?filenameTemplate={{id}}')
        .type('csv')
        .send(sampleData)
        .expect(200)

      expect(response.body).toHaveProperty('branch')
      const branch = response.body.branch
      expect(branch).toMatch('pr-')

      const { stdout } = await execa('git', ['ls-tree', branch])
      const lines = stdout.split('\n')
      expect(lines.length).toBe(SAMPLE_DATA_ROW_COUNT)
    })

    test('omitting filenameTemplate throws an error', async () => {
      const sampleData = fs.readFileSync(SAMPLE_DATA_CHANGED)

      const response = await request(server.callback())
        .post('/master/import')
        .type('csv')
        .send(sampleData)
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

async function loadSampleData () {
  const fileStream = fs.createReadStream(SAMPLE_DATA)
  const filenameTemplate = '{{id}}'
  const treeHash = await explode({ fileStream, filenameTemplate })
  const commitHash = await git.commitTree(treeHash, {
    p: 'HEAD',
    m: 'sample data'
  })
  await git.updateRef('HEAD', commitHash)
}
