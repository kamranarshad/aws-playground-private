import os

def handler(event, context):
    return {
        "region": os.environ.get("AWS_REGION"),
        "fnName": os.environ.get("AWS_LAMBDA_FUNCTION_NAME"),
        "custom": os.environ.get("CUSTOM_VAR"),
        "leak": os.environ.get("SHOULD_NOT_LEAK"),
    }
