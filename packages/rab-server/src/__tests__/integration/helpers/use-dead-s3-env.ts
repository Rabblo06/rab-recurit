import { useS3Env } from './s3-env';

/** Side-effect import (must be FIRST): selects the S3 driver but points it at an endpoint where nothing listens — storage is DOWN. */
useS3Env({ S3_ENDPOINT: 'http://127.0.0.1:1' });
