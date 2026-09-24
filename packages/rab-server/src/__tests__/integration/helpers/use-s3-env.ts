import { S3_TEST, useS3Env } from './s3-env';

/** Side-effect import: must be the FIRST import of a spec that boots AppModule against S3 (env is frozen at import). */
if (S3_TEST.enabled) useS3Env();
