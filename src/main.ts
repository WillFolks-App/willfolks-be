import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import { env } from './env.js';
import { setupApp } from './setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  setupApp(app);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('WillFolks API').setVersion('0.1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(env.port, env.host);
  Logger.log(`WillFolks API on http://${env.host}:${env.port} · docs at /docs`, 'Bootstrap');
  if (env.devLogin) Logger.warn('AUTH_DEV_LOGIN is on: anyone who can reach this API can sign in as anyone', 'Bootstrap');
}
await bootstrap();
