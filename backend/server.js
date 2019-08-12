const Koa = require('koa')
const Router = require('koa-router')
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

  if (!(await gitSheets.checkIsValidRepo())) {
    throw new Error(`invalid repo ${gitSheets.repo.gitDir}`)
  }

  router.get('/:ref', async (ctx) => {
    const ref = ctx.params.ref
    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')
    try {
      const rows = await gitSheets.getRows(ref)
      ctx.body = rows
    } catch (err) {
      if (err.message.startsWith('invalid tree ref')) {
        ctx.throw(404, 'unknown ref')
      } else {
        throw err
      }
    }
  })

  router.post('/:ref/import', async (ctx) => {
    const ref = ctx.params.ref
    const readStream = ctx.req
    const pathTemplate = ctx.request.query.path
    const branch = ctx.request.query.branch || ref

    ctx.assert(pathTemplate, 400, 'missing path query param')
    ctx.assert(ctx.request.type == 'text/csv', 415, 'content-type must be text/csv')
    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')
    ctx.assert(validPathTemplatePattern.test(pathTemplate), 400, 'invalid path template')

    let treeHash
    try {
      treeHash = await gitSheets.makeTreeFromCsv({ readStream, pathTemplate })
    } catch (err) {
      ctx.throw(422, err.message)
    }

    try {
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
      if (err.message.includes('Not a valid object name')) {
        ctx.throw(404, 'unknown ref')
      } else {
        throw err
      }
    }
  })

  router.get('/:srcRef/compare/:dstRef', async (ctx) => {
    const { srcRef, dstRef } = ctx.params

    ctx.assert(validRefPattern.test(srcRef), 400, 'invalid src ref')
    ctx.assert(validRefPattern.test(dstRef), 400, 'invalid dst ref')

    const diffs = await gitSheets.getDiffs(srcRef, dstRef)
    ctx.body = diffs
  })

  router.post('/:srcRef/compare/:dstRef', async (ctx) => {
    const { srcRef, dstRef } = ctx.params

    ctx.assert(validRefPattern.test(srcRef), 400, 'invalid src ref')
    ctx.assert(validRefPattern.test(dstRef), 400, 'invalid dst ref')

    try {
      await gitSheets.merge(srcRef, dstRef)
      ctx.status = 204
    } catch (err) {
      if (err.message.includes('not an ancestor of')) {
        ctx.throw(409, err.message)
      } else {
        throw err
      }
    }
  })

  async function errorHandler (ctx, next) {
    try {
      await next()
    } catch (err) {
      if (err.status) {
        ctx.status = err.status
        ctx.body = { message: err.message }
      } else {
        ctx.status = 500
        ctx.body = { message: 'An unexpected error occurred' }
      }
    }
  }

  return app
    .use(errorHandler)
    .use(router.routes())
    .use(router.allowedMethods())
}
