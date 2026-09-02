// Every fixed loopback port the playground binds or connects to, in one
// place. These leak across module boundaries -- the MinIO container is
// configured with the S3 trigger listener's port, and the web app shows the
// HTTP trigger's port in a copyable URL -- so a literal in each consumer
// means a silent mismatch the moment one of them changes.
//
// 9324-9325 (ElasticMQ), 9400-9404 are the docker-backed local services;
// 9500-9501 are listeners this process binds itself.
const offset = parseInt(process.env.AWS_PLAYGROUND_PORT_OFFSET || '0', 10) || 0;
const port = (def, envKey) => {
  if (envKey && process.env[envKey]) {
    const val = parseInt(process.env[envKey], 10);
    if (Number.isFinite(val)) return val;
  }
  return def + offset;
};

const PORTS = Object.freeze({
  httpTrigger: port(9500, 'AWS_PLAYGROUND_HTTP_TRIGGER_PORT'),
  s3Webhook: port(9501, 'AWS_PLAYGROUND_S3_WEBHOOK_PORT'),
  minio: port(9400, 'AWS_PLAYGROUND_MINIO_PORT'),
  minioConsole: port(9401, 'AWS_PLAYGROUND_MINIO_CONSOLE_PORT'),
  dynamodb: port(9402, 'AWS_PLAYGROUND_DYNAMODB_PORT'),
  redis: port(9403, 'AWS_PLAYGROUND_REDIS_PORT'),
  postgres: port(9404, 'AWS_PLAYGROUND_POSTGRES_PORT'),
  elasticmq: port(9324, 'AWS_PLAYGROUND_ELASTICMQ_PORT'),
  elasticmqConsole: port(9325, 'AWS_PLAYGROUND_ELASTICMQ_CONSOLE_PORT'),
});

module.exports = { PORTS };
