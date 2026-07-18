// Sample Lambda behind an API Gateway HTTP API (payload format 2.0).
// Register this folder in the playground with handler `index.handler`
// and invoke it with the events in ./events/.

const JSON_HEADERS = { 'content-type': 'application/json' };

function respond(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';

  if (method === 'GET' && path === '/hello') {
    const name = event.queryStringParameters?.name ?? 'world';
    return respond(200, { message: `hello, ${name}` });
  }

  if (method === 'POST' && path === '/echo') {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : event.body ?? '';
    try {
      return respond(200, { received: JSON.parse(raw) });
    } catch {
      return respond(400, { error: 'invalid JSON body' });
    }
  }

  return respond(404, { error: 'not found' });
};
