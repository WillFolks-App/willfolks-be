import { resolve } from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment and the defaults below.
}

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production');
}

const chainEnabled = (process.env.CHAIN_ENABLED ?? 'false') === 'true';

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://willfolks:willfolks@127.0.0.1:5432/willfolks',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-local-dev-secret',
  devLogin: (process.env.AUTH_DEV_LOGIN ?? String(!isProduction)) === 'true',
  aiVerifierMode: process.env.AI_VERIFIER_MODE === 'manual' ? ('manual' as const) : ('auto-approve' as const),
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  uploadsDir: resolve(process.env.UPLOADS_DIR ?? 'uploads'),
  /** Escrow on-chain (fase 1). Con `CHAIN_ENABLED=false` el backend mantiene el libro simulado. */
  chain: {
    enabled: chainEnabled,
    name: process.env.CHAIN_NAME ?? 'monad-testnet',
    id: Number(process.env.CHAIN_ID ?? 10143),
    rpcUrl: process.env.CHAIN_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
    explorerUrl: (process.env.CHAIN_EXPLORER_URL ?? 'https://testnet.monadscan.com').replace(/\/$/, ''),
    usdc: process.env.USDC_ADDRESS ?? '',
    escrow: process.env.ESCROW_ADDRESS ?? '',
    attestorKey: process.env.ATTESTOR_PRIVATE_KEY ?? '',
    treasuryKey: process.env.TREASURY_PRIVATE_KEY ?? '',
    faucetUsdc: Number(process.env.FAUCET_USDC ?? 3),
    faucetGasMon: process.env.FAUCET_GAS_MON ?? '0.25',
    /** Si es mayor que 0, las metas con escrow duran este tiempo en vez de llegar a `endDate` (demos y pruebas). */
    goalSeconds: Number(process.env.CHAIN_GOAL_SECONDS ?? 0),
    sweepMs: Number(process.env.CHAIN_SWEEP_MS ?? 15_000),
  },
};
