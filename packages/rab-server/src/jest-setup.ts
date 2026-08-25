// class-validator/class-transformer decorators need reflect-metadata loaded
// before any decorated class is touched. NestJS's own bootstrap (main.ts)
// loads it implicitly via @nestjs/core, but a unit test that imports a
// decorated class directly — without ever going through Nest bootstrap —
// does not get that for free.
import 'reflect-metadata';

// RabThrottlerModule skips rate limiting whenever this is 'true' AND
// JEST_WORKER_ID is set (the latter can never be true outside an actual
// Jest run, so this can't leak into a real deployment even by accident).
// The integration suite shares one IP across many spec files that each hit
// /auth/login repeatedly within the same 60s window — none of that is real
// abuse. `rate-limiting.integration.spec.ts` flips this back to 'false' at
// its own top level to exercise the real throttle end-to-end.
process.env.RAB_DISABLE_RATE_LIMIT = 'true';
