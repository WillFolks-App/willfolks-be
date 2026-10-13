import { DefaultNamingStrategy, ValueTransformer } from 'typeorm';

const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Maps camelCase properties onto the snake_case columns of willfolks-database. */
export class SnakeNamingStrategy extends DefaultNamingStrategy {
  override columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    return customName ?? snake([...embeddedPrefixes, propertyName].join('_'));
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snake(`${relationName}_${referencedColumnName}`);
  }
}

/** Postgres returns `numeric` as a string; amounts here fit safely in a double. */
export const numeric: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};

/** `time` columns come back as HH:MM:SS; the API speaks HH:MM. */
export const hhmm: ValueTransformer = {
  to: (value?: string | null) => value,
  from: (value?: string | null) => (typeof value === 'string' ? value.slice(0, 5) : value),
};

export const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** A random 32-byte hash standing in for an on-chain transaction until the escrow contract is wired. */
export function simulatedTxHash(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Drops the keys a request left out. DTO classes declare every field, so an instance
 * carries `undefined` for the absent ones, which would overwrite real values on assign.
 */
export function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
