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
 * This plugin keeps one rule: a request that arrived through a reverse proxy is
 * first admitted by dsh's own gate (trustedHosts fence + signed browser cookie,
 * the check /api runs). Only an admitted request is then presented to the
 * plugin as the loopback request it expects. A genuine local client is left
 * completely untouched, so each downstream plugin's own trust rule still
 * decides (reasoning-effort trusts any IP-literal host; skill-explorer requires
 * loopback), and a proxy cannot fake locality by forwarding a forged Host.
 */
import { request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream'

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

/** Whether a socket peer address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  const v4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether the request reached dsh through a reverse proxy.
 *
 * This — not the Host header — is what separates a remote browser from a local
 * client. A proxy always adds forwarding markers, and `proxy_set_header`
 * REPLACES whatever the client sent, so a remote caller cannot suppress them.
 */
function isProxied(req) {
  const h = req.headers
  return h['x-forwarded-for'] !== undefined
    || h['x-forwarded-proto'] !== undefined
    || h['x-forwarded-host'] !== undefined
    || h['x-real-ip'] !== undefined
    || h['forwarded'] !== undefined
}

/**
 * Whether this is a genuine local client, whose request the downstream plugin
 * should judge for itself.
 *
 * A local client is trustworthy because the Host header cannot be spoofed into
 * skipping a gate it never needed: dsh binds 127.0.0.1, so reaching it directly
 * already requires host access. Crucially this branch must NOT be keyed on the
 * Host header alone — a reverse proxy that forwards the client's own Host would
 * then let any remote caller send `Host: 127.0.0.1` and bypass `admit()`
 * entirely (CVE-class auth bypass: unauthenticated skill-explorer reads/writes).
 *
 * The downstream rules this preserves, so the local path stays native:
 *   - dsh-better-reasoning-effort trusts a loopback OR any IP-literal Host;
 *   - dsh-client-ui-skill-explorer requires a loopback socket address AND a
 *     loopback Host.
 * Proxied requests never take this branch, so a public browser is always
 * admitted by dsh's own gate before any rewriting happens.
 */
function isDirectClient(req) {
  return isLoopbackAddress(req.socket?.remoteAddress) && !isProxied(req)
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
      // A genuine local client keeps the route's native semantics untouched —
      // including the downstream rule that trusts any IP-literal Host.
      if (isDirectClient(req)) return route.handler(req, res)
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
      if (isDirectClient(req)) return route.handler(req, res)
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
        // pipeline closes the downstream on a truncated upstream response;
        // pipe alone leaves an already-started response hanging indefinitely.
        pipeline(up, res, err => { if (err) ctx.logger.warn(err) })
      },
    )
    upstream.on('error', err => {
      ctx.logger.warn(err)
      if (res.destroyed) return
      if (res.headersSent) res.destroy(err)
      else { res.writeHead(502); res.end() }
    })
    // An idle management request must not inherit nginx's one-hour wait.
    upstream.setTimeout(300_000, () => upstream.destroy(new Error('bili management proxy timed out')))
    req.once('aborted', () => upstream.destroy())
    res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
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
