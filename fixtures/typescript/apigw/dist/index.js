"use strict";
// Sample TypeScript Lambda behind an API Gateway HTTP API (payload v2).
// Register the fixture folder with handler `dist/index.handler` and build
// command `npm run build` (run `npm install` here once to get tsc).
// The compiled dist/index.js is committed so the fixture works untouched.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const JSON_HEADERS = { 'content-type': 'application/json' };
function respond(statusCode, payload) {
    return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}
const handler = async (event) => {
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath ?? '/';
    if (method === 'GET' && path === '/hello') {
        const name = event.queryStringParameters?.name ?? 'world';
        return respond(200, { message: `hello, ${name} (typescript)` });
    }
    if (method === 'POST' && path === '/sum') {
        const raw = event.isBase64Encoded
            ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
            : event.body ?? '';
        let numbers;
        try {
            numbers = JSON.parse(raw);
        }
        catch {
            return respond(400, { error: 'invalid JSON body' });
        }
        if (!Array.isArray(numbers) || numbers.some((n) => typeof n !== 'number')) {
            return respond(400, { error: 'body must be a JSON array of numbers' });
        }
        return respond(200, { sum: numbers.reduce((a, b) => a + b, 0) });
    }
    return respond(404, { error: 'not found' });
};
exports.handler = handler;
