import time

def handler(event, context):
    time.sleep(30)
    return {"never": True}
