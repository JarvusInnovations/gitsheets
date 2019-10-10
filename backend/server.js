const Koa = require('koa')
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const { format: csvFormat } = require('fast-csv')
const JsonStringify = require('streaming-json-stringify')
const GitSheets = require('./lib/GitSheets')

const validRefPattern = /^[\w-\/]+$/
const validPathTemplatePattern = /^[{}\w- \/]+$/

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

  router.get('/config/:ref+', async (ctx) => {
    const ref = ctx.params.ref
    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')

    const config = await gitSheets.getConfig(ref)
    ctx.body = { config }
  })

  router.put('/config/:ref+', bodyParser(), async (ctx) => {
    const ref = ctx.params.ref
    const { path } = ctx.request.body.config
    const config = { path }

    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')
    ctx.assert(validPathTemplatePattern.test(path), 400, 'invalid path template')

    await gitSheets.setConfig(ref, config)
    ctx.status = 204
  })

  router.get('/records/:ref+', async (ctx) => {
    const ref = ctx.params.ref
    const format = ctx.query.format
    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')

    const rows = await gitSheets.export(ref)

    switch (format || ctx.accepts('json', 'csv')) {
      case 'csv':
        ctx.type = 'text/csv'
        ctx.set('Content-Disposition', `attachment; filename=${ref}.csv`)
        ctx.body = rows.pipe(csvFormat({ headers: true }))
        break
      default:
        ctx.type = 'application/json'
        ctx.body = rows.pipe(JsonStringify())
    }
  })

  router.post('/import/:ref+', async (ctx) => {
    const ref = ctx.params.ref
    const readStream = ctx.req
    const branch = ctx.request.query.branch || ref

    ctx.assert(ctx.is('csv'), 415, 'content-type must be text/csv')
    ctx.assert(validRefPattern.test(ref), 400, 'invalid ref')

    await gitSheets.import({
      data: readStream,
      dataType: 'csv',
      parentRef: ref,
      saveToBranch: branch
    })
    ctx.status = 204
  })

  router.get('/compare/:srcRef([\\w-\\/]+)..:dstRef([\\w-\\/]+)', async (ctx) => {
    const { srcRef, dstRef } = ctx.params

    ctx.assert(validRefPattern.test(srcRef), 400, 'invalid src ref')
    ctx.assert(validRefPattern.test(dstRef), 400, 'invalid dst ref')

    const diffs = await gitSheets.compare(srcRef, dstRef)
    ctx.body = diffs
  })

  router.post('/compare/:srcRef([\\w-\\/]+)..:dstRef([\\w-\\/]+)', async (ctx) => {
    const { srcRef, dstRef } = ctx.params
    const msg = ctx.query.msg

    ctx.assert(validRefPattern.test(srcRef), 400, 'invalid src ref')
    ctx.assert(validRefPattern.test(dstRef), 400, 'invalid dst ref')

    await gitSheets.merge(srcRef, dstRef, msg)
    ctx.status = 204
  })

  async function errorHandler (ctx, next) {
    try {
      await next()
    } catch (err) {
      if (err.status) {
        ctx.status = err.status
        ctx.body = { message: err.message, code: err.constructor.name }
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
