import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { put } from '@vercel/blob';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageEngine, diskStorage } from 'multer';

import { env } from '../env.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** Streams the upload to Vercel Blob; `file.path` becomes its public URL. */
function blobStorage(folder: string): StorageEngine {
  return {
    _handleFile(_request: Request, file, done) {
      // The name never comes from the client, so it cannot escape the folder.
      const filename = `${randomUUID()}.${EXTENSIONS[file.mimetype]}`;
      put(`${folder}/${filename}`, file.stream, {
        access: 'public',
        contentType: file.mimetype,
        token: env.blobToken,
        addRandomSuffix: false,
      }).then(
        (blob) => done(null, { filename, path: blob.url }),
        (error) => done(error),
      );
    },
    _removeFile(_request: Request, _file, done) {
      done(null);
    },
  };
}

/** Multer options for a single image stored under `uploads/<folder>/` (or Blob) with a random name. */
export function imageUpload(folder: string): MulterOptions {
  let storage: StorageEngine;
  if (env.blobToken) {
    storage = blobStorage(folder);
  } else {
    const destination = join(env.uploadsDir, folder);
    mkdirSync(destination, { recursive: true });
    storage = diskStorage({
      destination,
      filename: (_request, file, done) => done(null, `${randomUUID()}.${EXTENSIONS[file.mimetype]}`),
    });
  }
  return {
    storage,
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, done) =>
      file.mimetype in EXTENSIONS
        ? done(null, true)
        : done(new BadRequestException(`Unsupported image type: ${file.mimetype}`), false),
  };
}

/** Where a stored upload lives: the Blob URL, or the `/uploads/...` path the server serves. */
export function uploadedPath(folder: string, file: Express.Multer.File): string {
  return /^https?:\/\//.test(file.path ?? '') ? file.path : `/uploads/${folder}/${file.filename}`;
}
