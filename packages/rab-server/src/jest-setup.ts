// class-validator/class-transformer decorators need reflect-metadata loaded
// before any decorated class is touched. NestJS's own bootstrap (main.ts)
// loads it implicitly via @nestjs/core, but a unit test that imports a
// decorated class directly — without ever going through Nest bootstrap —
// does not get that for free.
import 'reflect-metadata';
