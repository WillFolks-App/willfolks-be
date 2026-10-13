import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { env } from './env.js';

/** HTTP-level configuration shared by the server and the e2e tests. */
export function setupApp(app: NestExpressApplication): void {
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // Uploaded avatars and proofs are public by URL; their names are random UUIDs.
  app.useStaticAssets(env.uploadsDir, { prefix: '/uploads', index: false, dotfiles: 'deny' });
}
