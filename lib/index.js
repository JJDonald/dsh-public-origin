/**
 * dsh-public-origin — make loopback-assuming plugins work when the Web UI is
 * reached through a public domain behind a reverse proxy.
 *
 * Several plugins assume the browser talks to dsh on 127.0.0.1:
 *   - routes that only admit a loopback / IP-literal Host header
 *     (dsh-better-reasoning-effort, dsh-client-ui-skill-explorer);
 *   - billion-context, whose settings panel iframes its own loopback-only
 *     management UI at http://127.0.0.1:<zone port>/__bili/ and whose
 *     management API rejects any Origin other than its own loopback origin.
 *
 * This plugin keeps one rule: a request from a non-loopback Host is first
 * admitted by dsh's own gate (trustedHosts fence + signed browser cookie,
 * the check /api runs). Only an admitted request is then presented to the
 * plugin as the loopback request it expects. Loopback requests are untouched.
 */
import { request as httpRequest } from 'node:http'

export const name = 'dsh-public-origin'
export const inject = ['webServer', 'connection']

const DEFAULT_LOCALIZE = ['/dsh-better-reasoning-effort', '/api/dsh-skill-explorer']
const BILI_ORIGIN_ROUTE = '/bili/origin'
const BILI_MOUNT = '/__bili'

/** Request headers never forwarded to the bili management server. */
const PROXY_DROP = ['host', 'origin', 'referer', 'cookie', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-real-ip', 'connection', 'keep-alive', 'upgrade']

function underPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isLoopbackHost(req) {
  let hostname
  try {
    hostname = new URL(`http://${req.headers.host}`).hostname
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

function publicOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return `${proto}://${req.headers.host}`
}

export function apply(ctx, config) {
  const localize = config?.localize ?? DEFAULT_LOCALIZE
  const ws = ctx.webServer
  const connection = ctx.connection
  const match = ws.match

  /** bili's real management origin, read in-process from its own /bili/origin route. */
  const biliOrigin = () => {
    const route = match.call(ws, BILI_ORIGIN_ROUTE)
    if (route === undefined) return undefined
    let body = ''
    const capture = { writeHead: () => capture, setHeader() {}, end: chunk => { body = String(chunk) } }
    route.handler({ method: 'GET', url: BILI_ORIGIN_ROUTE, headers: {} }, capture)
    return JSON.parse(body).origin ?? undefined
  }

  /** dsh's own Host fence + browser login; answers the request when it refuses. */
  const admit = (req, res) => {
    const status = connection.requestRejection(req)
    if (status === undefined) return true
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(status === 401 ? 'unauthorized' : 'forbidden')
    return false
  }

  /** Admitted public request → the loopback request the plugin was written for. */
  const localized = route => ({
    ...route,
    handler: (req, res) => {
      if (isLoopbackHost(req)) return route.handler(req, res)
      if (!admit(req, res)) return
      req.headers.host = `127.0.0.1:${ws.port}`
      delete req.headers.origin
      return route.handler(req, res)
    },
  })

  /** Public browsers get the same-origin mount instead of bili's loopback origin. */
  const biliOriginView = route => ({
    ...route,
    handler: (req, res) => {
      if (isLoopbackHost(req)) return route.handler(req, res)
      if (!admit(req, res)) return
      const origin = biliOrigin() === undefined ? null : publicOrigin(req)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ origin }))
    },
  })

  /** Same-origin mount of bili's management UI/API, behind dsh's login. */
  const biliProxy = (req, res) => {
    if (!admit(req, res)) return
    const origin = biliOrigin()
    if (origin === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bili proxy is not bound to this dsh process')
      return
    }
    const target = new URL(origin)
    const headers = { ...req.headers }
    for (const h of PROXY_DROP) delete headers[h]
    headers.host = target.host
    const upstream = httpRequest(
      { hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      up => {
        const out = { ...up.headers }
        delete out.connection
        delete out['keep-alive']
        res.writeHead(up.statusCode, out)
        up.pipe(res)
      },
    )
    upstream.on('error', err => {
      ctx.logger.warn(err)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }

  // One choke point for routes registered before or after this plugin: wrap
  // the matched route on the way out of webServer.match.
  const wrapped = new WeakMap()
  ws.match = function (pathname) {
    const route = match.call(this, pathname)
    if (route === undefined) return route
    let wrap
    if (route.path === BILI_ORIGIN_ROUTE) wrap = biliOriginView
    else if (localize.some(prefix => underPrefix(route.path, prefix))) wrap = localized
    else return route
    let out = wrapped.get(route)
    if (out === undefined) {
      out = wrap(route)
      wrapped.set(route, out)
    }
    return out
  }
  ctx.effect(() => () => { delete ws.match }, 'dsh-public-origin: route localizer')
  ctx.effect(() => ws.register({ kind: 'prefix', path: BILI_MOUNT, handler: biliProxy }), 'dsh-public-origin: bili mount')
}
