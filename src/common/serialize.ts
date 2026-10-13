import { env } from '../env.js';
import type { User } from '../entities/index.js';

/** Uploaded files are stored as `/uploads/...`; expose them as absolute URLs when PUBLIC_URL is set. */
export function mediaUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith('/') ? `${env.publicUrl}${path}` : path;
}

/** The slice of a user other people are allowed to see. */
export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: mediaUrl(user.avatarUrl),
    locationLabel: user.locationLabel,
    timezone: user.timezone,
  };
}

export function privateUser(user: User) {
  return {
    ...publicUser(user),
    email: user.email,
    authProvider: user.authProvider,
    walletAddress: user.walletAddress,
    chain: user.chain,
    locale: user.locale,
    onboardingCompletedAt: user.onboardingCompletedAt,
    createdAt: user.createdAt,
  };
}
