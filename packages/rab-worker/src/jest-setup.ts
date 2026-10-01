// class-validator/TypeORM decorators (imported transitively via @rab/server
// entities) need reflect-metadata loaded before any decorated class is
// touched — see rab-server's own jest-setup.ts for the identical reasoning.
import 'reflect-metadata';
