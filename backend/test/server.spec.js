const request = require('supertest')
const createServer = require('../server')

const GIT_REF = 'fb070046498551bb49ce253ef13daddcb56949c1'

describe('server', () => {
  let server

  beforeEach(async () => {
    server = await createServer(GIT_REF)
  })

  it('lists rows', async () => {
    await request(server.callback())
      .get('/')
      .expect(200)
      .then((res) => {
        expect(Array.isArray(res.body)).toBe(true)
        expect(res.body.length).toBe(3)
      })
  })
})
