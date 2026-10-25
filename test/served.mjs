/**
 * Reads the bundle the Host is serving right now and checks that the markers
 * of the current implementation are in it. A stale revision here means the page
 * would run older code than the checkout.
 */
const markers = {
  'dismiss listeners': 'data-dsh-trash-trigger',
  'drawer squeeze variable': '--dsh-trash-sq',
  'menus outside the drawer': 'dsh-trash-session-item',
  'trash glyph on destructive entries': 'dsh-trash-menu-icon',
  'delete label': "'删除'",
}

const res = await fetch('http://127.0.0.1:3080/plugins/events', { headers: { accept: 'text/event-stream' } })
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''
const deadline = Date.now() + 6000
while (Date.now() < deadline) {
  const { value, done } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  if (buf.includes('dsh-trash-can')) break
}
const match = buf.match(/"id":"dsh-trash-can","url":"([^"]+)","rev":"([0-9a-f]+)"/)
if (!match) {
  console.log('not found in the client graph')
  process.exit(1)
}
const body = await (await fetch(`http://127.0.0.1:3080/${match[1]}`)).text()
console.log('served rev:', match[2], 'bytes:', body.length)

let missing = 0
for (const [label, marker] of Object.entries(markers)) {
  const present = body.includes(marker)
  if (!present) missing += 1
  console.log(`${present ? 'PASS' : 'FAIL'}  ${label}`)
}

await reader.cancel().catch(() => {})
process.exit(missing ? 1 : 0)
