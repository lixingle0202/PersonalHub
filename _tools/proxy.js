// 仅用于开发者工具调试：去掉 Origin / Referer，让后端不再判定为跨站
// 用法：node proxy.js                       → 转发到本机后端 127.0.0.1:8765
//       TARGET=https://your.domain node proxy.js  → 转发到线上域名
const http = require('http')
const https = require('https')
const { URL } = require('url')

const TARGET = process.env.TARGET || 'http://127.0.0.1:8765'
const PORT = Number(process.env.PORT || 8786)
const target = new URL(TARGET)
const agent = new https.Agent({ keepAlive: true })

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers)
  delete headers.origin
  delete headers.referer
  delete headers.host
  headers.host = target.host

  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
    agent: target.protocol === 'https:' ? agent : undefined
  }

  const up = (target.protocol === 'https:' ? https : http).request(opts, (r) => {
    res.writeHead(r.statusCode, r.headers)
    r.pipe(res)
  })
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'proxy error: ' + e.message }))
  })
  req.pipe(up)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('proxy ' + PORT + ' -> ' + TARGET)
})
