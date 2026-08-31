// Every fixed loopback port the playground binds or connects to, in one
// place. These leak across module boundaries -- the MinIO container is
// configured with the S3 trigger listener's port, and the web app shows the
// HTTP trigger's port in a copyable URL -- so a literal in each consumer
// means a silent mismatch the moment one of them changes.
//
// 9400-9404 are the docker-backed local services; 9500-9501 are listeners
// this process binds itself.
const PORTS = Object.freeze({
  httpTrigger: 9500,
  s3Webhook: 9501,
  minio: 9400,
  minioConsole: 9401,
  dynamodb: 9402,
  redis: 9403,
  postgres: 9404,
});

module.exports = { PORTS };
