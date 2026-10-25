/**
 * Reads the live client-module graph over the Host's SSE route and reports
 * whether this plugin's bundle is part of it. This is the only way to confirm
 * the browser half is served without a browser session.
 */
const response = await fetch('http://127.0.0.1:3080/plugins/events', {
  headers: { accept: 'text/event-stream' },
})

console.log('status:', response.status, response.headers.get('content-type'))
if (!response.ok) process.exit(2)

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const deadline = Date.now() + 8000

while (Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  if (buffer.includes('dsh-trash-can') || buffer.length > 400_000) break
}

console.log('graph bytes:', buffer.length)
console.log('mentions dsh-trash-can:', buffer.includes('dsh-trash-can'))
console.log('mentions meow-cachebilling:', buffer.includes('meow-cachebilling'))
const at = buffer.indexOf('dsh-trash-can')
if (at >= 0) console.log('context:', buffer.slice(Math.max(0, at - 160), at + 200))
else console.log('head:', buffer.slice(0, 600))

await reader.cancel().catch(() => {})
process.exit(0)
