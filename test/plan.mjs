/**
 * Exercises the Host planning path outside a booted profile: summary,
 * produced-file detection, and attachment discovery against a real stored
 * Session. Read-only.
 */
import { __internals } from '../index.js'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('usage: node test/plan.mjs <sessionId>')
  process.exit(2)
}

const started = Date.now()
const plan = await __internals.planSession(null, {}, sessionId)
const events = __internals.parseEvents(plan.text)
const users = __internals.extractUserTexts(events)
const attachments = __internals.extractAttachmentIds(plan.text)

console.log(
  JSON.stringify(
    {
      ms: Date.now() - started,
      title: plan.title,
      summary: plan.summary,
      summaryLength: plan.summary.length,
      events: events.length,
      userMessages: users.length,
      firstUserText: users[0]?.slice(0, 80),
      products: plan.products.slice(0, 10).map((p) => p.path),
      productCount: plan.products.length,
      attachments: attachments.length,
      logBytes: plan.text.length,
    },
    null,
    2,
  ),
)
