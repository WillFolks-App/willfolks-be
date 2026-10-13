#!/usr/bin/env node
// Humo e2e contra la red real: actúa como la app móvil frente a un backend en marcha.
//   API_URL=http://127.0.0.1:3000 node scripts/monad-smoke.mjs
// Requiere CHAIN_ENABLED=true y, para ver el ciclo completo, CHAIN_GOAL_SECONDS=180.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const WAIT_FOR_UNLOCK = process.env.SKIP_WAIT !== '1';
const log = (...a) => console.log(...a);
const must = (cond, msg) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } else log('  ok  ', msg); };

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

const cfg = await call('GET', '/chain/config');
must(cfg.enabled, `chain on: ${cfg.name} (${cfg.chainId}) escrow ${cfg.escrow}`);
const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [process.env.RPC_URL ?? cfg.rpcUrl] } } });
const rpcUrl = process.env.RPC_URL ?? cfg.rpcUrl;
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ESCROW = parseAbi([
  'function createGoal(uint128,uint40,uint40,uint16,uint8,bytes32) returns (uint256)',
  'function getGoal(uint256) view returns ((address,uint40,uint40,uint16,uint128,uint40,uint8,uint8,bytes32))',
]);
const STATE = ['none', 'active', 'succeeded', 'failed', 'claimed', 'expired', 'cancelled'];

// --- una "app" nueva: llave propia en el dispositivo, cuenta y wallet vinculada
const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const email = `smoke-${Date.now().toString(36)}@willfolks.test`;
const session = await call('POST', '/auth/login', null, { email, displayName: 'Smoke' });
const token = session.accessToken;
log(`\nusuario ${email}\nwallet  ${account.address}`);

const info = await call('GET', '/chain/wallet', token);
await call('POST', '/chain/wallet', token, { address: account.address, signature: await account.signMessage({ message: info.linkMessage }) });
const funded = await call('POST', '/chain/faucet', token);
must(funded.balance >= cfg.faucet.usdc, `faucet: ${funded.balance} USDC  ${funded.explorer}`);

const usdc = async () => Number(await pub.readContract({ address: cfg.usdc, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) / 1e6;
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function openGoal(title, extra = {}) {
  const goal = await call('POST', '/goals', token, {
    kind: 'alarm', title, stakeAmount: 1, endDate: day, repeatDays: [0, 1, 2, 3, 4, 5, 6],
    alarm: { targetTime: '07:00', reactionSeconds: 60 }, maxAttempts: 1, extraLockDays: 0, ...extra,
  });
  const p = goal.escrowParams;
  const approveHash = await wallet.writeContract({ address: cfg.usdc, abi: ERC20, functionName: 'approve', args: [cfg.escrow, BigInt(p.stake)] });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  // Los nodos públicos balancean carga: se espera a ver el allowance antes de enviar createGoal.
  for (let i = 0; i < 20; i++) {
    const allowance = await pub.readContract({ address: cfg.usdc, abi: parseAbi(['function allowance(address,address) view returns (uint256)']), functionName: 'allowance', args: [account.address, cfg.escrow] });
    if (allowance >= BigInt(p.stake)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await wallet.writeContract({
        address: cfg.escrow, abi: ESCROW, functionName: 'createGoal',
        args: [BigInt(p.stake), p.startAt, p.endAt, p.lockDays, p.kind, p.metadataHash],
      });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const confirmed = await call('POST', `/goals/${goal.id}/escrow`, token, { txHash: hash });
  return { id: goal.id, hash, goal: confirmed };
}

log('\n1) crear dos metas de 1 USDC (cada una: approve + createGoal firmados por la wallet)');
const before = await usdc();
const toFail = await openGoal('Smoke · falla');
const toPass = await openGoal('Smoke · cumple');
must(toFail.goal.escrow.state === 'active' && toPass.goal.escrow.state === 'active', 'ambas quedaron activas y confirmadas por el backend');
must((await usdc()) === before - 2, `la wallet pagó 2 USDC de stake (${before} -> ${await usdc()})`);
log(`      ${cfg.explorerUrl}/tx/${toFail.hash}`);
log(`      ${cfg.explorerUrl}/tx/${toPass.hash}`);

log('\n2) la meta que falla: el check-in falla y el atestador firma el fallo en la cadena');
await call('POST', `/goals/${toFail.id}/checkins`, token, { source: 'alarm', result: 'fail' });
await call('POST', `/goals/${toPass.id}/checkins`, token, { source: 'alarm', result: 'success' });
const waitFor = async (id, wanted, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const g = await call('GET', `/goals/${id}`, token);
    if (wanted.includes(g.escrow.state)) return g;
    if (Date.now() > end) throw new Error(`goal ${id} stuck in ${g.escrow.state}: ${g.escrow.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
};
const failed = await waitFor(toFail.id, ['failed_locked', 'claimed'], 90_000);
must(failed.escrow.resolveTxHash, `veredicto de fallo en la cadena: ${cfg.explorerUrl}/tx/${failed.escrow.resolveTxHash}`);
const failedOnchain = await pub.readContract({ address: cfg.escrow, abi: ESCROW, functionName: 'getGoal', args: [BigInt(failed.escrow.goalId)] });
must(STATE[failedOnchain[7]] === 'failed', 'el contrato lo marca Failed y el stake sigue bloqueado');

if (!WAIT_FOR_UNLOCK) { log('\nSKIP_WAIT=1: se omite la espera del fin de la meta'); process.exit(0); }

log('\n3) esperar el fin de las metas (CHAIN_GOAL_SECONDS) para que el backend reclame y resuelva el éxito');
const wait = Math.max(0, Number(toPass.goal.escrow.endAt ? new Date(toPass.goal.escrow.endAt).getTime() : 0) - Date.now()) + 60_000;
log(`      ~${Math.ceil(wait / 1000)} s`);
const passed = await waitFor(toPass.id, ['succeeded'], wait + 120_000);
must(passed.escrow.resolveTxHash, `éxito en la cadena: ${cfg.explorerUrl}/tx/${passed.escrow.resolveTxHash}`);
const claimed = await waitFor(toFail.id, ['claimed'], 120_000);
must(claimed.escrow.claimTxHash, `bloqueo terminado y stake reclamado: ${cfg.explorerUrl}/tx/${claimed.escrow.claimTxHash}`);

must((await usdc()) === before, `la wallet recuperó todo: ${await usdc()} USDC`);
const wal = await call('GET', '/wallet', token);
must(wal.inEscrow === 0, `libro: en custodia ${wal.inEscrow}, disponible ${wal.available}`);
log('\nOK · ciclo completo en la red real');
