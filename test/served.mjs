const res = await fetch("http://127.0.0.1:3080/plugins/events", { headers: { accept: "text/event-stream" } })
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""
const deadline = Date.now() + 6000
while (Date.now() < deadline) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); if (buf.includes("dsh-trash-can")) break }
const m = buf.match(/"id":"dsh-trash-can","url":"([^"]+)","rev":"([0-9a-f]+)"/)
if (!m) { console.log("not found"); process.exit(1) }
const url = "http://127.0.0.1:3080/" + m[1]
const body = await (await fetch(url)).text()
console.log("rev:", m[2], "bytes:", body.length)
console.log("has new dismiss code:", body.includes("data-dsh-trash-trigger"), "| useDismiss:", body.includes("dsh-trash-panel-menu"))
await reader.cancel().catch(() => {})
process.exit(0)
