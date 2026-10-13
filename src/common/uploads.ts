import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { diskStorage } from 'multer';

import { env } from '../env.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** Multer options for a single image stored under `uploads/<folder>/` with a random name. */
export function imageUpload(folder: string): MulterOptions {
  const destination = join(env.uploadsDir, folder);
  mkdirSync(destination, { recursive: true });
  return {
    storage: diskStorage({
      destination,
      // The name never comes from the client, so it cannot escape the folder.
      filename: (_request, file, done) => done(null, `${randomUUID()}.${EXTENSIONS[file.mimetype]}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, done) =>
      file.mimetype in EXTENSIONS
        ? done(null, true)
        : done(new BadRequestException(`Unsupported image type: ${file.mimetype}`), false),
  };
}
