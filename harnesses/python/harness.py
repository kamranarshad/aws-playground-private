"""AWS Lambda Playground python harness.

Run with cwd = the user's project directory. Reads the event JSON from
stdin, loads <module>.<function> from the handler string, invokes it with
(event, context), and writes a result envelope to --result-file. All user
stdout/stderr passes through and is captured by the server as logs.
"""
import argparse
import importlib
import json
import os
import sys
import time
import traceback
import uuid


def write_result(path, payload):
    with open(path, "w") as f:
        json.dump(payload, f)


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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--handler", required=True)
    p.add_argument("--result-file", required=True)
    p.add_argument("--timeout-ms", type=int, default=30000)
    p.add_argument("--memory-mb", type=int, default=128)
    p.add_argument("--request-id", default=str(uuid.uuid4()))
    args = p.parse_args()

    sys.path.insert(0, os.getcwd())
    event = json.load(sys.stdin)

    module_name, _, func_name = args.handler.rpartition(".")
    if not module_name:
        write_result(args.result_file, {
            "ok": False, "phase": "init", "durationMs": 0,
            "error": {"type": "Runtime.MalformedHandlerName",
                      "message": "Bad handler '%s': expected 'module.function'" % args.handler,
                      "stackTrace": []}})
        return
    try:
        module = importlib.import_module(module_name)
        func = getattr(module, func_name)
    except Exception as e:
        write_result(args.result_file, {
            "ok": False, "phase": "init", "durationMs": 0,
            "error": {"type": type(e).__name__, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}})
        return

    ctx = Context(args.timeout_ms, args.memory_mb, args.request_id)
    start = time.monotonic()
    try:
        response = func(event, ctx)
        duration = (time.monotonic() - start) * 1000
        json.dumps(response)  # raises TypeError if not JSON-serializable
        write_result(args.result_file, {
            "ok": True, "phase": "invoke",
            "response": response, "durationMs": duration})
    except Exception as e:
        duration = (time.monotonic() - start) * 1000
        write_result(args.result_file, {
            "ok": False, "phase": "invoke", "durationMs": duration,
            "error": {"type": type(e).__name__, "message": str(e),
                      "stackTrace": traceback.format_exc().splitlines()}})


if __name__ == "__main__":
    main()
