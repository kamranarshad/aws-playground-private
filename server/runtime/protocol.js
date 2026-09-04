// The framing the parent and all four harnesses agree on.
//
// Requests are length-prefixed rather than newline-delimited because an event
// JSON may legally contain a literal newline inside a string; a line reader
// would split such a request in half.
//
// Responses come back through the per-request result file, exactly as they did
// when every invoke got its own process. What the sentinel adds is ordering:
// logs stream on stdout while the envelope lands out-of-band, so without an
// in-band marker the parent cannot know which log bytes belong to this invoke,
// or when the file is safe to read. NUL framing plus the request's UUID keeps
// it from colliding with handler output that happens to mention the marker.
const SENTINEL_PREFIX = '\0AWSPLAY-END:';
const SENTINEL_SUFFIX = '\0';

function encodeRequest(obj) {
  const json = JSON.stringify(obj);
  return `${Buffer.byteLength(json, 'utf8')}\n${json}`;
}

function sentinelFor(requestId) {
  return `${SENTINEL_PREFIX}${requestId}${SENTINEL_SUFFIX}`;
}

// null means "not yet" -- the caller keeps accumulating. Returning the
// remainder rather than discarding it matters for a handler that writes
// asynchronously after returning: that output belongs to the next invoke's
// logs, which is what real Lambda does with it too.
function splitAtSentinel(buffer, requestId) {
  const marker = sentinelFor(requestId);
  const at = buffer.indexOf(marker);
  if (at === -1) return null;
  return { logs: buffer.slice(0, at), rest: buffer.slice(at + marker.length) };
}

module.exports = {
  SENTINEL_PREFIX, SENTINEL_SUFFIX, encodeRequest, sentinelFor, splitAtSentinel,
};
