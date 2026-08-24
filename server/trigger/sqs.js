function buildSqsEvent(message, queueName) {
  return {
    Records: [{
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      attributes: {
        ApproximateReceiveCount: message.Attributes?.ApproximateReceiveCount ?? '1',
        SentTimestamp: message.Attributes?.SentTimestamp ?? '',
        SenderId: message.Attributes?.SenderId ?? '',
        ApproximateFirstReceiveTimestamp: message.Attributes?.ApproximateFirstReceiveTimestamp ?? '',
      },
      messageAttributes: message.MessageAttributes ?? {},
      md5OfBody: message.MD5OfBody,
      eventSource: 'aws:sqs',
      eventSourceARN: `arn:aws:sqs:elasticmq:000000000000:${queueName}`,
      awsRegion: 'elasticmq',
    }],
  };
}

module.exports = { buildSqsEvent };
