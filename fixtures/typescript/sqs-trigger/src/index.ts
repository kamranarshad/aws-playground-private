// Sample TypeScript Node lambda meant to be driven by the playground's SQS
// trigger: enable "SQS trigger queue" in this function's Settings and every
// message sent to that queue invokes this handler automatically. Whether the
// invoke comes from the trigger or a hand-crafted manual invoke, the event
// is the same real Lambda SQS shape ({ Records: [...] }) — this handler just
// reads what's already in it, no SQS client call needed.
//
// Register the folder with runtime `node`, handler `dist/index.handler`.
// The committed dist/index.js already bundles everything needed, so it runs
// untouched. playground.json auto-starts the local SQS service (ElasticMQ)
// when this function is selected, so the console at :9325 is one click away.
interface SqsRecord {
  messageId: string
  body: string
}

interface SqsEvent {
  Records?: SqsRecord[]
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export const handler = async (event: SqsEvent) => {
  const records = event.Records ?? []
  const messages = records.map((record) => {
    console.log(`received message ${record.messageId}: ${record.body}`)
    return { messageId: record.messageId, body: parseBody(record.body) }
  })
  return { ok: true, count: messages.length, messages }
}
