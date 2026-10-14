#!/usr/bin/env node
// Humo e2e de la integración con TilcAI contra Monad testnet: actúa como la app frente a un backend en marcha.
//   API_URL=http://127.0.0.1:3000 node scripts/tilcai-smoke.mjs
// Requiere CHAIN_ENABLED=true, TILCAI_ENABLED=true (vault, relayer, juez x402 y cuentas) y CHAIN_GOAL_SECONDS=180.
//
// Qué comprueba, siempre contra la cadena y no contra la respuesta del API:
//   1. faucet: el USDC sale del vault de TilcAI (Transfer desde el vault), no de la tesorería.
//   2. depósito fiat: igual, y el saldo real sube.
//   3. cuenta inteligente: se emite una SCA con passkey P-256 y tiene código en Monad.
//   4. juez IA por x402: la prueba se aprueba y su veredicto trae el hash de un pago de USDC real.
//   5. validación: `resolve` y `claim` los envía el relayer de TilcAI (tx.from), no la tesorería;
//      el veredicto sigue firmado por el atestador del backend.
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, parseAbi } from 'viem';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const log = (...a) => console.log(...a);
let failures = 0;
const must = (cond, msg) => {
  if (cond) log('  ok  ', msg);
  else {
    failures++;
    console.error('  FAIL', msg);
  }
};

async function call(method, path, token, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { ...(isForm || !body ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

const cfg = await call('GET', '/chain/config');
const status = await call('GET', '/tilcai/status');
must(cfg.enabled && status.enabled, `cadena ${cfg.name} (${cfg.chainId}) y TilcAI activos: ${JSON.stringify(status.capabilities)}`);
const relayerAddress = status.relayer.address.toLowerCase();

const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const ESCROW = parseAbi(['function createGoal(uint128,uint40,uint40,uint16,uint8,bytes32) returns (uint256)']);
const usdc = async (who) => Number(await pub.readContract({ address: cfg.usdc, abi: ERC20, functionName: 'balanceOf', args: [who] })) / 1e6;

/** Transfers of the token inside a transaction, decoded from its receipt. */
async function transfersIn(hash) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  const out = [];
  for (const entry of receipt.logs) {
    if (getAddress(entry.address) !== getAddress(cfg.usdc)) continue;
    try {
      const ev = decodeEventLog({ abi: ERC20, data: entry.data, topics: entry.topics });
      if (ev.eventName === 'Transfer') out.push({ from: ev.args.from.toLowerCase(), to: ev.args.to.toLowerCase(), value: Number(ev.args.value) / 1e6 });
    } catch {
      // not a Transfer
    }
  }
  return { receipt, transfers: out };
}

// --- una "app" nueva: llave propia en el dispositivo, cuenta y wallet vinculada
const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
const session = await call('POST', '/auth/login', null, { email: `tilcai-${Date.now().toString(36)}@willfolks.test`, displayName: 'TilcAI smoke' });
const token = session.accessToken;
const info = await call('GET', '/chain/wallet', token);
await call('POST', '/chain/wallet', token, { address: account.address, signature: await account.signMessage({ message: info.linkMessage }) });
log(`\nwallet ${account.address}`);

// 1) faucet
log('\n1) faucet: el USDC sale del vault de TilcAI');
const vaultAddress = process.env.VAULT_ADDRESS?.toLowerCase();
const faucet = await call('POST', '/chain/faucet', token);
{
  const { transfers } = await transfersIn(faucet.usdcTx);
  const t = transfers.find((x) => x.to === account.address.toLowerCase());
  must(t && t.value === cfg.faucet.usdc, `Transfer de ${t?.value} USDC a la wallet, desde ${t?.from}`);
  must(!vaultAddress || t?.from === vaultAddress, 'el origen es el vault de TilcAI');
  must(t?.from !== (process.env.TREASURY_ADDRESS ?? '').toLowerCase() || !process.env.TREASURY_ADDRESS, 'el origen no es la tesorería de WillFolks');
  log(`      ${cfg.explorerUrl}/tx/${faucet.usdcTx}`);
}
must((await usdc(account.address)) === cfg.faucet.usdc, `saldo real: ${await usdc(account.address)} USDC`);

// 2) depósito fiat
log('\n2) depósito fiat: el vault de TilcAI paga el USDC');
const beforeDeposit = await usdc(account.address);
const deposit = await call('POST', '/wallet/deposits', token, { amount: 1, method: 'fiat' });
must(/^0x[0-9a-f]{64}$/.test(deposit.txHash ?? ''), `el depósito trae un hash real: ${deposit.txHash}`);
{
  const { transfers } = await transfersIn(deposit.txHash);
  must(transfers.some((x) => x.to === account.address.toLowerCase() && x.value === 1), 'Transfer de 1 USDC a la wallet');
}
must((await usdc(account.address)) === beforeDeposit + 1, `saldo real: ${beforeDeposit} -> ${await usdc(account.address)} USDC`);

// 3) cuenta inteligente
log('\n3) cuenta inteligente (SCA) con passkey P-256');
{
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = `0x04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  const body = { publicKey: point, credentialId: Buffer.from('smoke-credential').toString('base64url'), rpId: 'willfolks.test' };
  const created = await call('POST', '/chain/account', token, body);
  must(created.state === 'ACTIVE', `SCA ${created.address} · ${created.state}`);
  const code = await pub.getCode({ address: created.address });
  must(code && code !== '0x', 'la dirección tiene código en Monad');
  const again = await call('POST', '/chain/account', token, body);
  must(again.address === created.address, 'pedirla otra vez devuelve la misma cuenta');
  const got = await call('GET', '/chain/account', token);
  must(got.account?.address === created.address && got.account.state === 'ACTIVE', 'GET /chain/account la devuelve ACTIVE');
}

// 4) meta con juez IA por x402
log('\n4) meta de IA: el veredicto se compra por x402 y el pago llega a la cadena');
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const goal = await call('POST', '/goals', token, {
  kind: 'ai',
  title: 'Smoke · tender la cama',
  stakeAmount: 1,
  endDate: day,
  repeatDays: [0, 1, 2, 3, 4, 5, 6],
  ai: { prompt: 'Foto de la cama tendida', verifier: 'ai' },
  maxAttempts: 1,
  extraLockDays: 0,
});
{
  const p = goal.escrowParams;
  const approve = await wallet.writeContract({ address: cfg.usdc, abi: ERC20, functionName: 'approve', args: [cfg.escrow, BigInt(p.stake)] });
  await pub.waitForTransactionReceipt({ hash: approve });
  for (let i = 0; i < 20; i++) {
    if ((await pub.readContract({ address: cfg.usdc, abi: ERC20, functionName: 'allowance', args: [account.address, cfg.escrow] })) >= BigInt(p.stake)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await wallet.writeContract({ address: cfg.escrow, abi: ESCROW, functionName: 'createGoal', args: [BigInt(p.stake), p.startAt, p.endAt, p.lockDays, p.kind, p.metadataHash] });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const confirmed = await call('POST', `/goals/${goal.id}/escrow`, token, { txHash: hash });
  must(confirmed.escrow.state === 'active', `meta activa en la cadena: ${cfg.explorerUrl}/tx/${hash}`);
}
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('photo', new Blob([png], { type: 'image/png' }), 'cama.png');
  const t0 = Date.now();
  const proved = await call('POST', `/goals/${goal.id}/proofs`, token, form);
  must(proved.proof.status === 'approved', `prueba aprobada por el juez en ${Math.round((Date.now() - t0) / 1000)} s`);
  const paid = /tx (0x[0-9a-fA-F]{64})/.exec(proved.proof.verdictReason ?? '')?.[1];
  must(Boolean(paid), `el veredicto cita el pago x402: ${proved.proof.verdictReason}`);
  if (paid) {
    const { transfers } = await transfersIn(paid);
    must(transfers.some((x) => x.value === 0.01), `el pago es un Transfer de 0.01 USDC: ${JSON.stringify(transfers)}`);
    log(`      ${cfg.explorerUrl}/tx/${paid}`);
  }
}

// 5) validación por el relayer de TilcAI
log('\n5) validación: resolve y claim los envía el relayer de TilcAI con el veredicto firmado por el backend');
const waitFor = async (id, wanted, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const g = await call('GET', `/goals/${id}`, token);
    if (wanted.includes(g.escrow.state)) return g;
    if (Date.now() > end) throw new Error(`goal ${id} stuck in ${g.escrow.state}: ${g.escrow.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
};
const finished = await waitFor(goal.id, ['succeeded', 'claimed'], 8 * 60_000);
const resolveTx = await pub.getTransaction({ hash: finished.escrow.resolveTxHash });
must(resolveTx.from.toLowerCase() === relayerAddress, `resolve enviada por el relayer de TilcAI (${resolveTx.from}) · ${cfg.explorerUrl}/tx/${resolveTx.hash}`);
must(resolveTx.to.toLowerCase() === cfg.escrow.toLowerCase(), 'resolve apunta al escrow de WillFolks');
must(resolveTx.input.toLowerCase().includes(cfg.attestor.slice(2).toLowerCase()), 'el calldata nombra al atestador del backend, cuya firma EIP-712 valida el contrato');
const wal = await call('GET', '/wallet', token);
must(wal.inEscrow === 0, `libro: en custodia ${wal.inEscrow}`);

log(failures ? `\n${failures} comprobaciones FALLARON` : '\nOK · integración con TilcAI verificada en la red real');
process.exit(failures ? 1 : 0);
