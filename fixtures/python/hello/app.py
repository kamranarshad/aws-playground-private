def handler(event, context):
    print("hello log line")
    return {
        "message": "hello from python",
        "echo": event,
        "requestId": context.aws_request_id,
        "remaining": context.get_remaining_time_in_millis() > 0,
    }
