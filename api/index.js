// Vercel entry point: the Nest app, built into dist/ by `npm run build`, behind one function.
import { NestFactory } from '@nestjs/core';
// TypeORM loads the driver with a dynamic require, which file tracing cannot see.
import 'pg';

import { AppModule } from '../dist/app.module.js';
import { setupApp } from '../dist/setup.js';

let server;

async function boot() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  setupApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function handler(request, response) {
  server ??= boot();
  return (await server)(request, response);
}
