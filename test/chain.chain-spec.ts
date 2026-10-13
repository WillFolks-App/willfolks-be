import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Fase 1 de punta a punta: usuario, base de datos, backend, contrato y wallet.
 *
 * Levanta su propio Anvil, despliega el USDC de prueba y WillFolksEscrow desde
 * willfolks-smartcontracts, y recorre el ciclo de una meta como lo hace la app: el usuario
 * firma `approve` y `createGoal` con su propia llave, el backend verifica el recibo, el
 * atestador firma el veredicto y la tesorería lo envía. El tiempo avanza con evm_increaseTime.
 */

const PORT = 8560;
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS = resolve(process.cwd(), '../willfolks-smartcontracts');
const MNEMONIC = 'test test test test test test test test test test test junk';
// Cuentas 0 y 1 de Anvil: tesorería/dueño y atestador. Solo para pruebas locales.
const TREASURY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ATTESTOR_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const chain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC) });

const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address to, uint256 amount)',
]);
const ESCROW = parseAbi([
  'function createGoal(uint128 stake, uint40 startAt, uint40 endAt, uint16 lockDays, uint8 kind, bytes32 metadataHash) returns (uint256)',
  'function cancel(uint256 goalId)',
  'function getGoal(uint256 goalId) view returns ((address creator, uint40 startAt, uint40 endAt, uint16 lockDays, uint128 stake, uint40 unlockAt, uint8 kind, uint8 state, bytes32 metadataHash))',
  'function totalLocked() view returns (uint256)',
]);

const STATE = { active: 1, succeeded: 2, failed: 3, claimed: 4, cancelled: 6 } as const;
const units = (amount: number) => BigInt(Math.round(amount * 1_000_000));

describe('WillFolks · fase 1 on-chain (e2e)', () => {
  let anvil: ChildProcess;
  let app: NestExpressApplication;
  let http_: App;
  let sweep: () => Promise<void>;
  let usdc: Address;
  let escrow: Address;

  const run = Date.now().toString(36);
  // Las fechas siguen al reloj de la cadena: la suite lo adelanta con evm_increaseTime.
  let chainNow = Math.floor(Date.now() / 1000);
  const chainDay = (days: number) => new Date((chainNow + days * 86_400) * 1000).toISOString().slice(0, 10);

  interface Actor {
    email: string;
    token: string;
    id: string;
    key: Hex;
    address: Address;
  }
  const actor = (name: string): Actor => {
    const key = generatePrivateKey();
    return { email: `chain-${name}-${run}@willfolks.test`, token: '', id: '', key, address: privateKeyToAccount(key).address };
  };
  const ana = actor('ana');
  const leo = actor('leo');

  const api = (user: { token: string }) => ({
    get: (path: string) => request(http_).get(path).auth(user.token, { type: 'bearer' }),
    post: (path: string, body?: object) => request(http_).post(path).auth(user.token, { type: 'bearer' }).send(body),
    delete: (path: string) => request(http_).delete(path).auth(user.token, { type: 'bearer' }),
  });

  const walletOf = (user: Actor) =>
    createWalletClient({ account: privateKeyToAccount(user.key), chain, transport: http(RPC) });

  const rpc = (method: string, params: unknown[] = []) =>
    fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((response) => response.json());
  const warp = async (seconds: number) => {
    await rpc('evm_increaseTime', [seconds]);
    await rpc('evm_mine');
  };

  const balanceOf = (address: Address) =>
    publicClient.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [address] });
  const onchain = (id: string | number | bigint) =>
    publicClient.readContract({ address: escrow, abi: ESCROW, functionName: 'getGoal', args: [BigInt(id)] });

  const signUp = async (user: Actor) => {
    const login = await request(http_).post('/auth/login').send({ email: user.email, displayName: user.email.split('@')[0] }).expect(200);
    user.token = login.body.accessToken;
    user.id = login.body.user.id;
  };

  const linkWallet = async (user: Actor) => {
    const info = await api(user).get('/chain/wallet').expect(200);
    const signature = await privateKeyToAccount(user.key).signMessage({ message: info.body.linkMessage });
    await api(user).post('/chain/wallet', { address: user.address, signature }).expect(201);
  };

  const alarmGoal = (overrides: object = {}) => ({
    kind: 'alarm',
    title: 'Wake up 06:30',
    stakeAmount: 5,
    endDate: chainDay(1),
    repeatDays: [0, 1, 2, 3, 4, 5, 6],
    alarm: { targetTime: '06:30', reactionSeconds: 60 },
    maxAttempts: 1,
    extraLockDays: 3,
    ...overrides,
  });

  /** What the app does after POST /goals: approve, createGoal, then confirm with the backend. */
  const lockOnChain = async (user: Actor, created: { id: string; escrowParams: Record<string, string | number> }) => {
    const p = created.escrowParams;
    const wallet = walletOf(user);
    await publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: usdc, abi: ERC20, functionName: 'approve', args: [escrow, BigInt(p.stake)] }),
    });
    const hash = await wallet.writeContract({
      address: escrow,
      abi: ESCROW,
      functionName: 'createGoal',
      args: [BigInt(p.stake), Number(p.startAt), Number(p.endAt), Number(p.lockDays), Number(p.kind), p.metadataHash as Hex],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  const openGoal = async (user: Actor, overrides: object = {}) => {
    const created = await api(user).post('/goals', alarmGoal(overrides)).expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.escrow.state).toBe('pending');
    const hash = await lockOnChain(user, created.body);
    const confirmed = await api(user).post(`/goals/${created.body.id}/escrow`, { txHash: hash }).expect(200);
    return { id: created.body.id as string, hash, goal: confirmed.body };
  };

  beforeEach(async () => {
    if (publicClient) chainNow = Number((await publicClient.getBlock()).timestamp);
  });

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await rpc('eth_chainId').then(() => true, () => false)) break;
      await new Promise((done) => setTimeout(done, 100));
    }

    const attestor = privateKeyToAccount(ATTESTOR_KEY).address;
    execFileSync(
      'forge',
      ['script', 'script/DeployEscrowLocal.s.sol:DeployEscrowLocalScript', '--rpc-url', RPC, '--broadcast'],
      { cwd: CONTRACTS, env: { ...process.env, PRIVATE_KEY: TREASURY_KEY, ESCROW_ATTESTOR: attestor }, stdio: 'pipe' },
    );
    const broadcast = JSON.parse(
      execFileSync('cat', ['broadcast/DeployEscrowLocal.s.sol/31337/run-latest.json'], { cwd: CONTRACTS }).toString(),
    ) as { transactions: { contractName: string; contractAddress: Address }[] };
    usdc = broadcast.transactions.find((tx) => tx.contractName === 'MockERC20')!.contractAddress;
    escrow = broadcast.transactions.find((tx) => tx.contractName === 'WillFolksEscrow')!.contractAddress;

    const treasury = createWalletClient({ account: privateKeyToAccount(TREASURY_KEY), chain, transport: http(RPC) });
    await publicClient.waitForTransactionReceipt({
      hash: await treasury.writeContract({
        address: usdc,
        abi: ERC20,
        functionName: 'mint',
        args: [privateKeyToAccount(TREASURY_KEY).address, units(1_000)],
      }),
    });

    Object.assign(process.env, {
      CHAIN_ENABLED: 'true',
      CHAIN_NAME: 'anvil-local',
      CHAIN_ID: '31337',
      CHAIN_RPC_URL: RPC,
      CHAIN_EXPLORER_URL: 'http://localhost/explorer',
      USDC_ADDRESS: usdc,
      ESCROW_ADDRESS: escrow,
      ATTESTOR_PRIVATE_KEY: ATTESTOR_KEY,
      TREASURY_PRIVATE_KEY: TREASURY_KEY,
      FAUCET_USDC: '20',
      FAUCET_GAS_MON: '1',
      FAUCET_COOLDOWN_HOURS: '24',
      CHAIN_GOAL_SECONDS: '0',
      CHAIN_SWEEP_MS: '0',
    });

    // Se importa después de fijar el entorno: env.ts lo lee una sola vez al cargarse.
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module.js');
    const { setupApp } = await import('../src/setup.js');
    const { ChainSweeper } = await import('../src/chain/chain.sweeper.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    http_ = app.getHttpServer();
    const sweeper = app.get(ChainSweeper);
    sweep = () => sweeper.pass();
    void MNEMONIC;
  });

  afterAll(async () => {
    for (const user of [ana, leo]) if (user.token) await api(user).delete('/users/me');
    await app?.close();
    anvil?.kill();
  });

  describe('wallet y faucet', () => {
    it('publica la configuración de la red sin autenticación', async () => {
      const config = await request(http_).get('/chain/config').expect(200);
      expect(config.body).toMatchObject({
        enabled: true,
        chainId: 31337,
        usdc: expect.stringMatching(/^0x/),
        escrow: expect.stringMatching(/^0x/),
        maxStake: 100,
      });
      expect(config.body.escrow.toLowerCase()).toBe(escrow.toLowerCase());
    });

    it('rechaza vincular una wallet sin demostrar que se tiene la llave', async () => {
      await signUp(ana);
      await signUp(leo);
      const forged = await privateKeyToAccount(leo.key).signMessage({ message: 'WillFolks wallet link\nuser:' + ana.id });
      const response = await api(ana).post('/chain/wallet', { address: ana.address, signature: forged }).expect(400);
      expect(response.body.code).toBe('BAD_SIGNATURE');
    });

    it('vincula la wallet y entrega fondos de prueba una sola vez', async () => {
      await linkWallet(ana);
      await linkWallet(leo);
      expect((await api(ana).get('/users/me').expect(200)).body.walletAddress.toLowerCase()).toBe(ana.address.toLowerCase());

      const funded = await api(ana).post('/chain/faucet').expect(201);
      expect(funded.body.usdc).toBe(20);
      expect(await balanceOf(ana.address)).toBe(units(20));

      const again = await api(ana).post('/chain/faucet').expect(429);
      expect(again.body.code).toBe('FAUCET_COOLDOWN');

      const ledger = await api(ana).get('/wallet/transactions').expect(200);
      expect(ledger.body[0]).toMatchObject({ type: 'deposit', method: 'crypto', txHash: funded.body.usdcTx });
      expect((await api(ana).get('/wallet').expect(200)).body.available).toBe(20);
    });

    it('no deja que dos cuentas compartan wallet', async () => {
      const intruder = actor('dup');
      await signUp(intruder);
      const signature = await privateKeyToAccount(ana.key).signMessage({ message: `WillFolks wallet link\nuser:${intruder.id}` });
      const response = await api(intruder).post('/chain/wallet', { address: ana.address, signature }).expect(409);
      expect(response.body.code).toBe('WALLET_TAKEN');
      await api(intruder).delete('/users/me');
    });
  });

  describe('crear metas', () => {
    it('exige wallet vinculada', async () => {
      const lonely = actor('lonely');
      await signUp(lonely);
      const response = await api(lonely).post('/goals', alarmGoal()).expect(400);
      expect(response.body.code).toBe('WALLET_REQUIRED');
      await api(lonely).delete('/users/me');
    });

    it('rechaza saldo insuficiente, tope y metas compartidas', async () => {
      expect((await api(leo).post('/goals', alarmGoal()).expect(400)).body.code).toBe('INSUFFICIENT_FUNDS');
      expect((await api(ana).post('/goals', alarmGoal({ stakeAmount: 500 })).expect(400)).body.code).toBe('STAKE_ABOVE_CAP');
      expect(
        (await api(ana).post('/goals', alarmGoal({ participantIds: [leo.id] })).expect(400)).body.code,
      ).toBe('GROUP_NOT_SUPPORTED');
      expect((await api(ana).post('/goals', alarmGoal({ extraLockDays: 120 })).expect(400)).body.code).toBe('LOCK_TOO_LONG');
    });

    it('deja la meta en borrador hasta que el stake está en el contrato', async () => {
      const created = await api(ana).post('/goals', alarmGoal({ title: 'Borrador' })).expect(201);
      expect(created.body).toMatchObject({ status: 'draft', escrow: { state: 'pending' } });
      expect(created.body.escrowParams).toMatchObject({ chainId: 31337, stake: '5000000', lockDays: 3, kind: 0 });
      expect((await api(ana).get('/goals').expect(200)).body.find((g: { id: string }) => g.id === created.body.id)).toBeUndefined();
      // Sin transacción no hay confirmación posible.
      const noTx = await api(ana).post(`/goals/${created.body.id}/escrow`, { txHash: `0x${'ab'.repeat(32)}` }).expect(400);
      expect(noTx.body.code).toBe('TX_NOT_FOUND');
      await api(ana).delete(`/goals/${created.body.id}`).expect(204);
    });

    it('bloquea el stake en el contrato y lo refleja en la base y el libro', async () => {
      const before = await balanceOf(ana.address);
      const { id, hash, goal } = await openGoal(ana, { title: 'Meta con stake' });

      expect(goal).toMatchObject({ status: 'active', escrow: { state: 'active', createTxHash: hash } });
      expect(goal.escrow.goalId).toMatch(/^\d+$/);
      expect(await balanceOf(ana.address)).toBe(before - units(5));
      expect(await balanceOf(escrow)).toBe(units(5));

      const stored = await onchain(goal.escrow.goalId);
      expect(stored.creator.toLowerCase()).toBe(ana.address.toLowerCase());
      expect(stored.stake).toBe(units(5));
      expect(stored.state).toBe(STATE.active);

      const wallet = (await api(ana).get('/wallet').expect(200)).body;
      expect(wallet).toMatchObject({ available: 15, inEscrow: 5 });
      const lock = (await api(ana).get('/wallet/transactions').expect(200)).body.find((t: { type: string }) => t.type === 'stake_lock');
      expect(lock).toMatchObject({ goalId: id, txHash: hash, method: 'crypto' });

      // Confirmar dos veces es idempotente.
      await api(ana).post(`/goals/${id}/escrow`, { txHash: hash }).expect(200);
      await api(ana).delete(`/goals/${id}`).expect(409);
      // Dejar la meta resuelta para el resto de la suite.
      await api(ana).post(`/goals/${id}/checkins`, { source: 'alarm', result: 'success' }).expect(200);
    });

    it('no acepta la transacción de otra persona ni una distinta a la preparada', async () => {
      const mine = await api(ana).post('/goals', alarmGoal({ title: 'Mía' })).expect(201);
      const hash = await lockOnChain(ana, mine.body);

      // Leo intenta reclamar la meta de Ana con la transacción de Ana.
      await api(leo).post('/chain/faucet').expect(201);
      const theirs = await api(leo).post('/goals', alarmGoal({ title: 'De Leo' })).expect(201);
      const response = await api(leo).post(`/goals/${theirs.body.id}/escrow`, { txHash: hash }).expect(400);
      expect(response.body.code).toBe('TX_MISMATCH');

      // Ana confirma bien; la misma transacción no puede servir a otra meta suya.
      await api(ana).post(`/goals/${mine.body.id}/escrow`, { txHash: hash }).expect(200);
      const other = await api(ana).post('/goals', alarmGoal({ title: 'Otra' })).expect(201);
      await api(ana).post(`/goals/${other.body.id}/escrow`, { txHash: hash }).expect(400);

      await api(leo).delete(`/goals/${theirs.body.id}`).expect(204);
      await api(ana).delete(`/goals/${other.body.id}`).expect(204);
      await api(ana).post(`/goals/${mine.body.id}/checkins`, { source: 'alarm', result: 'success' }).expect(200);
    });
  });

  describe('resolución por el atestador', () => {
    // Las metas de la sección anterior siguen abiertas: se cierran para medir saldos limpios.
    beforeAll(async () => {
      await warp(3 * 86_400);
      await sweep();
      await sweep();
    });

    it('devuelve el stake al cumplir la meta', async () => {
      const { id, goal } = await openGoal(ana, { title: 'Cumplida' });
      const before = await balanceOf(ana.address);
      await api(ana).post(`/goals/${id}/checkins`, { source: 'alarm', result: 'success' }).expect(200);

      // Antes del fin de la meta el éxito no se puede atestar.
      await sweep();
      expect((await api(ana).get(`/goals/${id}`).expect(200)).body.escrow.state).toBe('active');
      expect((await onchain(goal.escrow.goalId)).state).toBe(STATE.active);

      await warp(3 * 86_400);
      await sweep();
      await sweep();

      const done = (await api(ana).get(`/goals/${id}`).expect(200)).body;
      expect(done.escrow.error).toBeNull();
      expect(done).toMatchObject({ status: 'completed', escrow: { state: 'succeeded' } });
      expect(done.escrow.resolveTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await onchain(goal.escrow.goalId)).state).toBe(STATE.succeeded);
      expect(await balanceOf(ana.address)).toBe(before + units(5));

      const release = (await api(ana).get('/wallet/transactions').expect(200)).body.find(
        (t: { type: string; goalId: string }) => t.type === 'stake_release' && t.goalId === id,
      );
      expect(release).toMatchObject({ method: 'crypto', txHash: done.escrow.resolveTxHash });
    });

    it('bloquea el stake al fallar y lo devuelve al terminar el bloqueo', async () => {
      const { id, goal } = await openGoal(ana, { title: 'Fallida', extraLockDays: 2 });
      const before = await balanceOf(ana.address);

      await api(ana).post(`/goals/${id}/checkins`, { source: 'alarm', result: 'fail' }).expect(200);
      await sweep();

      const failed = (await api(ana).get(`/goals/${id}`).expect(200)).body;
      expect(failed).toMatchObject({ status: 'failed', escrow: { state: 'failed_locked' } });
      expect(failed.escrow.unlockAt).toBeTruthy();
      expect((await onchain(goal.escrow.goalId)).state).toBe(STATE.failed);
      // El stake sigue en el contrato.
      expect(await balanceOf(ana.address)).toBe(before);

      // El bloqueo cuenta desde el fin de la meta, no desde el fallo.
      await warp(86_400);
      await sweep();
      expect((await api(ana).get(`/goals/${id}`).expect(200)).body.escrow.state).toBe('failed_locked');

      await warp(4 * 86_400);
      await sweep();
      const claimed = (await api(ana).get(`/goals/${id}`).expect(200)).body;
      expect(claimed.escrow.state).toBe('claimed');
      expect(claimed.escrow.claimTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await onchain(goal.escrow.goalId)).state).toBe(STATE.claimed);
      expect(await balanceOf(ana.address)).toBe(before + units(5));
    });

    it('cancela antes de empezar, desde la wallet del usuario', async () => {
      const { id, goal } = await openGoal(ana, { title: 'Cancelable', startDate: chainDay(3), endDate: chainDay(7) });
      const before = await balanceOf(ana.address);

      // La API no puede mover un stake que está en el contrato.
      expect((await api(ana).delete(`/goals/${id}`).expect(409)).body.code).toBe('CANCEL_ON_CHAIN');

      const hash = await walletOf(ana).writeContract({ address: escrow, abi: ESCROW, functionName: 'cancel', args: [BigInt(goal.escrow.goalId)] });
      await publicClient.waitForTransactionReceipt({ hash });
      const cancelled = await api(ana).post(`/goals/${id}/escrow/cancel`, { txHash: hash }).expect(200);

      expect(cancelled.body).toMatchObject({ status: 'cancelled', escrow: { state: 'cancelled' } });
      expect(await balanceOf(ana.address)).toBe(before + units(5));
      expect((await onchain(goal.escrow.goalId)).state).toBe(STATE.cancelled);
    });

    it('termina con el contrato sin fondos de las metas de la prueba', async () => {
      const locked = await publicClient.readContract({ address: escrow, abi: ESCROW, functionName: 'totalLocked' });
      expect(locked).toBe(await balanceOf(escrow));
      expect(locked).toBe(0n);
    });
  });
});
