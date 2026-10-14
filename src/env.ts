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

/** `unset` follows `fallback`; an explicit "true"/"false" wins. */
const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === '' ? fallback : value === 'true');

const tilcaiEnabled = (process.env.TILCAI_ENABLED ?? 'false') === 'true';
const tilcaiRelayerReady = Boolean(process.env.TILCAI_RELAYER_URL && process.env.TILCAI_RELAYER_API_KEY);

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://willfolks:willfolks@127.0.0.1:5432/willfolks',
  /** Conexiones por instancia: en serverless cada instancia abre las suyas, así que se mantienen pocas. */
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),
  /** Secreto del endpoint /internal/sweep (el cron de Vercel lo envía como `Authorization: Bearer`). */
  cronSecret: process.env.CRON_SECRET ?? '',
  /** Con token, las fotos se guardan en Vercel Blob en vez del disco (que en serverless es efímero). */
  blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? '',
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
    explorerUrl: (process.env.CHAIN_EXPLORER_URL ?? 'https://testnet.monadvision.com').replace(/\/$/, ''),
    usdc: process.env.USDC_ADDRESS ?? '',
    escrow: process.env.ESCROW_ADDRESS ?? '',
    attestorKey: process.env.ATTESTOR_PRIVATE_KEY ?? '',
    treasuryKey: process.env.TREASURY_PRIVATE_KEY ?? '',
    faucetUsdc: Number(process.env.FAUCET_USDC ?? 3),
    faucetGasMon: process.env.FAUCET_GAS_MON ?? '0.25',
    /** Monto del depósito fiat de prueba que ofrece la app con la cadena encendida. */
    fiatDepositUsdc: Number(process.env.FIAT_DEPOSIT_USDC ?? 1),
    /** Si es mayor que 0, las metas con escrow duran este tiempo en vez de llegar a `endDate` (demos y pruebas). */
    goalSeconds: Number(process.env.CHAIN_GOAL_SECONDS ?? 0),
    sweepMs: Number(process.env.CHAIN_SWEEP_MS ?? 15_000),
  },
  /**
   * TilcAI (tilcai-sdk). Con `TILCAI_ENABLED=false` el backend no la usa en absoluto. Cada
   * capacidad se enciende sola cuando su credencial existe y se puede apagar con su variable.
   */
  tilcai: {
    enabled: tilcaiEnabled,
    /** API de TilcAI (tilcai-infrastructure). */
    apiUrl: (process.env.TILCAI_API_URL ?? '').replace(/\/$/, ''),
    /** Clave de operador: desembolsos del vault. */
    apiKey: process.env.TILCAI_API_KEY ?? '',
    /** Clave de tercero con los scopes accounts:read y accounts:write; sin ella se usa `apiKey`. */
    accountsApiKey: process.env.TILCAI_ACCOUNTS_API_KEY ?? '',
    environment: process.env.TILCAI_NETWORK === 'mainnet' ? ('mainnet' as const) : ('testnet' as const),
    /** OpenZeppelin Relayer de TilcAI: valida x402 y envía las llamadas de validación. */
    relayerUrl: (process.env.TILCAI_RELAYER_URL ?? '').replace(/\/$/, ''),
    relayerApiKey: process.env.TILCAI_RELAYER_API_KEY ?? '',
    relayerId: process.env.TILCAI_RELAYER_ID ?? 'monad-testnet-relayer',
    /** El USDC sale del vault de TilcAI en vez de la tesorería. `TILCAI_VAULT_FUNDS` enciende las dos rutas; cada una se apaga sola. */
    vaultFaucet: flag(
      process.env.TILCAI_VAULT_FAUCET,
      flag(process.env.TILCAI_VAULT_FUNDS, tilcaiEnabled && Boolean(process.env.TILCAI_API_URL && process.env.TILCAI_API_KEY)),
    ),
    vaultDeposits: flag(
      process.env.TILCAI_VAULT_DEPOSITS,
      flag(process.env.TILCAI_VAULT_FUNDS, tilcaiEnabled && Boolean(process.env.TILCAI_API_URL && process.env.TILCAI_API_KEY)),
    ),
    /** `resolve`, `claim` y `reclaim` los envía el relayer de TilcAI; el veredicto lo firma este backend. */
    relayValidation: flag(process.env.TILCAI_RELAY_VALIDATION, tilcaiEnabled && tilcaiRelayerReady),
    /** El juez de IA se cobra por x402 en USDC de Monad. */
    judge: {
      enabled: flag(process.env.TILCAI_AI_JUDGE, false) && tilcaiEnabled && tilcaiRelayerReady,
      price: process.env.AI_JUDGE_PRICE ?? '0.01',
      /** Quien cobra por juzgar. Sin definir, la dirección del atestador. */
      payTo: process.env.AI_JUDGE_PAYTO ?? '',
      /** URL del juez. Sin definir, este mismo servidor. */
      url: (process.env.AI_JUDGE_URL ?? '').replace(/\/$/, ''),
    },
  },
};
