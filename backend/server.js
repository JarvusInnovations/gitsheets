const Koa = require('koa')
const Router = require('koa-router')
const assert = require('http-assert')
const git = require('git-client')
const GitSheets = require('./lib')

const validRefPattern = /^[\w-]+$/
const validPathTemplatePattern = /^[{}\w-\/]+$/

module.exports = createServer

if (!module.parent) {
  GitSheets.create()
    .then(createServer)
    .then((app) => {
      app.listen(3000)
    })
}

async function createServer (gitSheets) {
  const app = new Koa()
  const router = new Router()

  router.get('/:ref', async (ctx) => {
    const ref = ctx.params.ref
    assert(validRefPattern.test(ref), 400, 'invalid ref')
    const rows = await gitSheets.getRows(ref)
    ctx.body = rows
  })

  router.post('/:ref/import', async (ctx) => {
    const ref = ctx.params.ref
    const readStream = ctx.req
    const pathTemplate = ctx.request.query.path
    const branch = ctx.request.query.branch || ref

    assert(pathTemplate, 400, 'missing path query param')
    assert(ctx.request.type == 'text/csv', 400, 'content-type must be text/csv')
    assert(validRefPattern.test(ref), 400, 'invalid ref')
    assert(validPathTemplatePattern.test(pathTemplate), 400, 'invalid path template')

    try {
      const treeHash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate })
      if (branch === ref) {
        await gitSheets.saveTreeToExistingBranch({
          treeHash,
          branch,
          msg: 'import'
        })
      } else {
        await gitSheets.saveTreeToNewBranch({
          treeHash,
          parentRef: ref,
          branch,
          msg: 'import'
        })
      }
      ctx.status = 204
    } catch (err) {
      ctx.status = 500
    }
  })

  return app
    .use(router.routes())
    .use(router.allowedMethods())
}
