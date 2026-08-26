// Sample TypeScript Node lambda meant to be driven by the playground's
// DynamoDB Streams trigger: enable "DynamoDB Streams" in this function's
// trigger picker with a table name and every insert/update/delete on that
// table invokes this handler automatically. Whether the invoke comes from
// the trigger or a hand-crafted manual invoke, the event is the same real
// Lambda DynamoDB Streams shape ({ Records: [...] }) — this handler just
// reads what's already in it, no DynamoDB client call needed.
//
// Register the folder with runtime `node`, handler `dist/index.handler`.
// The committed dist/index.js already bundles everything needed, so it runs
// untouched. playground.json auto-starts the local DynamoDB service when
// this function is selected. The table itself must already exist — the
// trigger only enables its stream — so create it first (e.g. from another
// function, a setup script, or the AWS CLI against
// http://127.0.0.1:9402) before enabling the trigger.
interface DynamoDbRecord {
  eventID: string
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb: {
    Keys: Record<string, unknown>
    NewImage?: Record<string, unknown>
    OldImage?: Record<string, unknown>
  }
}

interface DynamoDbStreamEvent {
  Records?: DynamoDbRecord[]
}

export const handler = async (event: DynamoDbStreamEvent) => {
  const records = event.Records ?? []
  const changes = records.map((record) => {
    console.log(`${record.eventName} ${record.eventID}: ${JSON.stringify(record.dynamodb.Keys)}`)
    return { eventName: record.eventName, keys: record.dynamodb.Keys }
  })
  return { ok: true, count: changes.length, changes }
}
