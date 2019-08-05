const Koa = require('koa')
const Router = require('koa-router')
const git = require('git-client')
const { explode, listRows } = require('./lib')

module.exports = createServer

if (!module.parent) {
  createServer().then((app) => {
    app.listen(3000)
  })
}

async function createServer (gitRef) {
  const app = new Koa()
  const router = new Router()

  router.get('/', async (ctx) => {
    const rows = await listRows(gitRef)
    ctx.body = rows
  })

  return app
    .use(router.routes())
    .use(router.allowedMethods())
}
