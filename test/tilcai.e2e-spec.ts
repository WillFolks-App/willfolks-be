import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TilcAI integration without a chain or a database: the service and its flags against small
 * fakes of TilcAI's API and relayer. The real thing runs in scripts/tilcai-smoke.mjs.
 */
const OPERATOR_KEY = 'operator-key';
const RELAYER_KEY = 'relayer-key';
const ESCROW = '0x3422820Ef9FBC8e0206E4CBcB6369dBd14BE18c4';

interface Fake {
  server: Server;
  url: string;
  requests: Array<{ method: string; path: string; body: any }>;
}

async function fake(handler: (req: { method: string; path: string; body: any; auth: string | undefined }) => { status: number; body: unknown }): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', body });
      const answer = handler({ method: req.method ?? 'GET', path: req.url ?? '/', body, auth: req.headers.authorization });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const close = (f: Fake) =>
  new Promise<void>((done) => {
    f.server.closeAllConnections();
    f.server.close(() => done());
  });

/** Loads the service with a clean environment: `env.ts` reads `process.env` once, at import. */
async function load(vars: Record<string, string | undefined>) {
  const keys = Object.keys(process.env).filter((key) => key.startsWith('TILCAI_') || key.startsWith('AI_JUDGE'));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  vi.resetModules();
  const { TilcaiService } = await import('../src/tilcai/tilcai.service.js');
  return new TilcaiService();
}

describe('TilcAI integration', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('TILCAI_') || key.startsWith('AI_JUDGE')) delete process.env[key];
  });

  describe('flags', () => {
    it('does nothing unless it is enabled', async () => {
      const tilcai = await load({ TILCAI_API_URL: 'http://x', TILCAI_API_KEY: 'k', TILCAI_RELAYER_URL: 'http://r', TILCAI_RELAYER_API_KEY: 'k' });
      expect([tilcai.enabled, tilcai.vaultFaucet, tilcai.vaultDeposits, tilcai.relayValidation, tilcai.judgeEnabled]).toEqual([false, false, false, false, false]);
      await expect(tilcai.status()).resolves.toEqual({ enabled: false });
    });

    it('turns each capability on by its own credential', async () => {
      const onlyVault = await load({ TILCAI_ENABLED: 'true', TILCAI_API_URL: 'http://x', TILCAI_API_KEY: 'k' });
      expect([onlyVault.vaultFaucet, onlyVault.vaultDeposits, onlyVault.relayValidation, onlyVault.judgeEnabled]).toEqual([true, true, false, false]);

      const withRelayer = await load({
        TILCAI_ENABLED: 'true',
        TILCAI_RELAYER_URL: 'http://r',
        TILCAI_RELAYER_API_KEY: 'k',
        TILCAI_AI_JUDGE: 'true',
      });
      expect([withRelayer.vaultFaucet, withRelayer.relayValidation, withRelayer.judgeEnabled]).toEqual([false, true, true]);
    });

    it('lets each route be switched off on its own', async () => {
      const tilcai = await load({
        TILCAI_ENABLED: 'true',
        TILCAI_API_URL: 'http://x',
        TILCAI_API_KEY: 'k',
        TILCAI_VAULT_FAUCET: 'false',
        TILCAI_RELAY_VALIDATION: 'false',
      });
      expect([tilcai.vaultFaucet, tilcai.vaultDeposits, tilcai.relayValidation]).toEqual([false, true, false]);
    });

    it('refuses to build a client without its credentials', async () => {
      const tilcai = await load({ TILCAI_ENABLED: 'true' });
      expect(() => tilcai.api).toThrow(/TILCAI_API_URL and TILCAI_API_KEY/);
      expect(() => tilcai.relayer).toThrow(/TILCAI_RELAYER_URL/);
    });
  });

  describe('vault', () => {
    let api: Fake;
    let polls = 0;
    beforeAll(async () => {
      api = await fake(({ method, path, body, auth }) => {
        if (auth !== `Bearer ${OPERATOR_KEY}`) return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'no' } } };
        if (method === 'POST' && path === '/v1/vault/disbursements') {
          if (body.amount === '99') return { status: 422, body: { error: { code: 'BUDGET', message: 'Available budget is insufficient.', recovery: 'REVIEW_POLICY' } } };
          return { status: 201, body: { disbursement: { id: 'disb_1', state: 'REQUESTED' }, links: { tx: null } } };
        }
        if (path === '/v1/vault/disbursements/disb_1') {
          polls++;
          const done = polls >= 2;
          return { status: 200, body: { disbursement: { id: 'disb_1', state: done ? 'CONFIRMED' : 'SUBMITTED', txHash: done ? `0x${'ab'.repeat(32)}` : null }, links: {}, events: [] } };
        }
        return { status: 404, body: {} };
      });
    });
    afterAll(() => close(api));

    it('pays a reference once through the vault and returns the confirmed hash', async () => {
      const tilcai = await load({ TILCAI_ENABLED: 'true', TILCAI_API_URL: api.url, TILCAI_API_KEY: OPERATOR_KEY });
      const paid = await tilcai.disburse('0x36fb277393d2fe015a6a8819ff3ed7718efa6484', 0.7, 'wf-deposit-1');
      expect(paid).toEqual({ id: 'disb_1', txHash: `0x${'ab'.repeat(32)}` });
      const sent = api.requests.find((r) => r.method === 'POST')!;
      expect(sent.body).toEqual({ network: 'eip155:10143', to: '0x36fb277393D2FE015A6A8819fF3ED7718EFa6484', amount: '0.7', reference: 'wf-deposit-1' });
    });

    it("keeps TilcAI's error code for the app", async () => {
      const tilcai = await load({ TILCAI_ENABLED: 'true', TILCAI_API_URL: api.url, TILCAI_API_KEY: OPERATOR_KEY });
      await expect(tilcai.disburse('0x36fb277393d2fe015a6a8819ff3ed7718efa6484', 99, 'wf-too-much')).rejects.toMatchObject({
        status: 422,
        response: { code: 'TILCAI_VAULT_BUDGET' },
      });
    });
  });

  describe('relayer', () => {
    let relayer: Fake;
    beforeAll(async () => {
      relayer = await fake(({ method, path, body, auth }) => {
        if (auth !== `Bearer ${RELAYER_KEY}`) return { status: 401, body: { success: false, error: 'Unauthorized' } };
        if (method === 'POST' && path === '/api/v1/relayers/monad-testnet-relayer/transactions') {
          return { status: 201, body: { success: true, data: { id: 'tx-1', status: 'pending', hash: null, echoed: body } } };
        }
        if (path === '/api/v1/relayers/monad-testnet-relayer/transactions/tx-1') {
          return { status: 200, body: { success: true, data: { id: 'tx-1', status: 'confirmed', hash: `0x${'cd'.repeat(32)}` } } };
        }
        return { status: 404, body: { success: false, error: 'not found' } };
      });
    });
    afterAll(() => close(relayer));

    it('sends a validation call from the relayer and returns its confirmed hash', async () => {
      const tilcai = await load({ TILCAI_ENABLED: 'true', TILCAI_RELAYER_URL: relayer.url, TILCAI_RELAYER_API_KEY: RELAYER_KEY });
      const data = '0x1e83409a0000000000000000000000000000000000000000000000000000000000000007';
      const tx = await tilcai.relay(ESCROW, data);
      expect(tx.hash).toBe(`0x${'cd'.repeat(32)}`);
      const sent = relayer.requests.find((r) => r.method === 'POST')!;
      expect(sent.body).toMatchObject({ to: ESCROW, data, value: 0 });
    });

    it('surfaces a relayer rejection with a TILCAI_RELAY code', async () => {
      const tilcai = await load({ TILCAI_ENABLED: 'true', TILCAI_RELAYER_URL: relayer.url, TILCAI_RELAYER_API_KEY: 'wrong' });
      await expect(tilcai.relay(ESCROW, '0x01')).rejects.toMatchObject({ response: { code: expect.stringMatching(/^TILCAI_RELAY_/) } });
    });
  });
});
