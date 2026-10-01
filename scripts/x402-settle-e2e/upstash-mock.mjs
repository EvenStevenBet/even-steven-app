// Minimal in-memory Upstash Redis REST server for the e2e tests (copy of scripts/claim-e2e/upstash-mock.mjs).
// Implements only what lib/claim-abuse.ts uses: INCR, EXPIRE, SET (NX/EX), DEL,
// GET, FLUSHALL, via POST / (single command) and POST /pipeline.
import http from 'node:http'

export function startUpstashMock(port) {
  const data = new Map() // key -> { value, expiresAt }

  const live = (key) => {
    const e = data.get(key)
    if (e && e.expiresAt && e.expiresAt <= Date.now()) { data.delete(key); return undefined }
    return e
  }

  function exec([cmd, ...args]) {
    switch (String(cmd).toUpperCase()) {
      case 'INCR': {
        const e = live(args[0])
        const n = Number(e?.value ?? 0) + 1
        data.set(args[0], { value: String(n), expiresAt: e?.expiresAt })
        return n
      }
      case 'EXPIRE': {
        const e = live(args[0])
        if (!e) return 0
        e.expiresAt = Date.now() + Number(args[1]) * 1000
        return 1
      }
      case 'SET': {
        const [key, value, ...opts] = args
        const upper = opts.map((o) => String(o).toUpperCase())
        if (upper.includes('NX') && live(key)) return null
        const exIdx = upper.indexOf('EX')
        data.set(key, { value: String(value), expiresAt: exIdx >= 0 ? Date.now() + Number(opts[exIdx + 1]) * 1000 : undefined })
        return 'OK'
      }
      case 'GET': return live(args[0])?.value ?? null
      case 'DEL': return args.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0)
      case 'FLUSHALL': data.clear(); return 'OK'
      default: throw new Error(`unsupported command ${cmd}`)
    }
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const b64 = String(req.headers['upstash-encoding'] ?? '').toLowerCase() === 'base64'
      const enc = (r) => (b64 && typeof r === 'string' ? Buffer.from(r).toString('base64') : r)
      const run = (cmd) => { try { return { result: enc(exec(cmd)) } } catch (e) { return { error: e.message } } }
      const parsed = JSON.parse(body || '[]')
      const out = req.url.startsWith('/pipeline') ? parsed.map(run) : run(parsed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise((resolve) => server.listen(port, () => resolve({
    server,
    keys: () => [...data.keys()].filter((k) => live(k)),
    flush: () => data.clear(),
  })))
}
