"""AWS Lambda Playground python harness.

Run with cwd = the user's project directory. Loads <module>.<function> from
the handler string once, invokes it with (event, context), and writes a
result envelope to a result file. All user stdout/stderr passes through and
is captured by the server as logs.

Two modes. Without --warm it reads one event from stdin, writes the envelope
to --result-file and exits -- one process per invoke. With --warm it serves
length-prefixed requests from stdin until stdin closes, keeping module scope,
/tmp and any connection pools alive between them, which is what real Lambda
does with an execution environment. See server/runtime/protocol.js.
"""
import argparse
import importlib
import json
import os
import sys
import time
import traceback
import uuid


SENTINEL_PREFIX = "\0AWSPLAY-END:"
SENTINEL_SUFFIX = "\0"


def write_result(path, payload):
    with open(path, "w") as f:
        json.dump(payload, f)


def read_requests(stream):
    """Yields one decoded request per length-prefixed frame.

    Length-prefixed rather than line-delimited: an event JSON may contain a
    literal newline inside a string, which a line reader would split in half.
    """
    buf = b""
    need = None
    while True:
        if need is None:
            nl = buf.find(b"\n")
            if nl == -1:
                chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
                if not chunk:
                    return
                buf += chunk
                continue
            need = int(buf[:nl])
            buf = buf[nl + 1:]
        if len(buf) < need:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not chunk:
                return
            buf += chunk
            continue
        frame = buf[:need]
        buf = buf[need:]
        need = None
        yield json.loads(frame.decode("utf-8"))


class Context:
    def __init__(self, timeout_ms, memory_mb, request_id):
        self._deadline = time.monotonic() + timeout_ms / 1000.0
        self.function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "playground")
        self.function_version = os.environ.get("AWS_LAMBDA_FUNCTION_VERSION", "$LATEST")
        self.memory_limit_in_mb = memory_mb
        self.aws_request_id = request_id
        self.invoked_function_arn = "arn:aws:lambda:%s:000000000000:function:%s" % (
            os.environ.get("AWS_REGION", "us-east-1"), self.function_name)
        self.log_group_name = "/aws/lambda/" + self.function_name
        self.log_stream_name = "playground"

    def get_remaining_time_in_millis(self):
        return max(0, int((self._deadline - time.monotonic()) * 1000))


def resolve_handler(handler_spec):
    """Imported once. In warm mode its cost is the initMs reported on the
    first response only -- later invokes reuse this exact module instance,
    which is what makes module-scope state persist as it does on Lambda."""
    module_name, _, func_name = handler_spec.rpartition(".")
    if not module_name:
        raise ImportError("Bad handler '%s': expected 'module.function'" % handler_spec)
    module = importlib.import_module(module_name)
    return getattr(module, func_name)


def run_one(func, req, init_ms):
    ctx = Context(req["timeoutMs"], req["memoryMb"], req["requestId"])
    start = time.monotonic()
    try:
        response = func(req["event"], ctx)
        duration = (time.monotonic() - start) * 1000
        json.dumps(response)  # raises TypeError if not JSON-serializable
        envelope = {"ok": True, "phase": "invoke",
                    "response": response, "durationMs": duration}
        if init_ms is not None:
            envelope["initMs"] = init_ms
        write_result(req["resultFile"], envelope)
    except Exception as e:
        duration = (time.monotonic() - start) * 1000
        write_result(req["resultFile"], {
            "ok": False, "phase": "invoke", "durationMs": duration,
            "error": {"type": type(e).__name__, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}})


def main():
    harness_start = time.monotonic()
    p = argparse.ArgumentParser()
    p.add_argument("--handler", required=True)
    p.add_argument("--result-file", required=True)
    p.add_argument("--timeout-ms", type=int, default=30000)
    p.add_argument("--memory-mb", type=int, default=128)
    p.add_argument("--request-id", default=str(uuid.uuid4()))
    p.add_argument("--warm", action="store_true")
    args = p.parse_args()

    sys.path.insert(0, os.getcwd())

    try:
        func = resolve_handler(args.handler)
    except Exception as e:
        # Terminal in both modes: there is no handler to serve anything with.
        kind = ("Runtime.MalformedHandlerName" if isinstance(e, ImportError)
                and "expected" in str(e) else type(e).__name__)
        envelope = {
            "ok": False, "phase": "init", "durationMs": 0,
            "error": {"type": kind, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}}
        if not args.warm:
            write_result(args.result_file, envelope)
            return
        # The parent waits on a sentinel for the request *it* sent, not for
        # the one named on the command line, so report the init failure as the
        # answer to a real request. There is no handler to serve a second one.
        for req in read_requests(sys.stdin.buffer):
            write_result(req["resultFile"], envelope)
            sys.stdout.flush()
            sys.stderr.flush()
            sys.stdout.write(SENTINEL_PREFIX + req["requestId"] + SENTINEL_SUFFIX)
            sys.stdout.flush()
            break
        return

    init_ms = (time.monotonic() - harness_start) * 1000

    if not args.warm:
        run_one(func, {
            "requestId": args.request_id, "resultFile": args.result_file,
            "event": json.load(sys.stdin), "timeoutMs": args.timeout_ms,
            "memoryMb": args.memory_mb,
        }, init_ms)
        return

    first = True
    for req in read_requests(sys.stdin.buffer):
        run_one(func, req, init_ms if first else None)
        first = False
        # Flush before the sentinel: the parent cuts this invoke's logs at the
        # marker, so anything still buffered would land in the next invoke's.
        sys.stdout.flush()
        sys.stderr.flush()
        sys.stdout.write(SENTINEL_PREFIX + req["requestId"] + SENTINEL_SUFFIX)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
