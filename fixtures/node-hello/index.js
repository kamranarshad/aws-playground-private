exports.handler = async (event, context) => {
  console.log('node log line');
  return {
    message: 'hello from node',
    echo: event,
    requestId: context.awsRequestId,
    remaining: context.getRemainingTimeInMillis() > 0,
  };
};

exports.callbackHandler = (event, context, callback) => {
  setTimeout(() => callback(null, { message: 'hello from callback' }), 10);
};

exports.errorHandler = async () => {
  throw new TypeError('boom from node');
};
