import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  verifyMessage,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { env } from '../env.js';

const USDC_UNITS = 1_000_000;

export const ESCROW_ABI = parseAbi([
  'function createGoal(uint128 stake, uint40 startAt, uint40 endAt, uint16 lockDays, uint8 kind, bytes32 metadataHash) returns (uint256 goalId)',
  'function resolve(uint256 goalId, bool success, bytes32 evidenceHash, uint40 validUntil, address attestor, bytes signature)',
  'function claim(uint256 goalId)',
  'function reclaim(uint256 goalId)',
  'function cancel(uint256 goalId)',
  'function getGoal(uint256 goalId) view returns ((address creator, uint40 startAt, uint40 endAt, uint16 lockDays, uint128 stake, uint40 unlockAt, uint8 kind, uint8 state, bytes32 metadataHash))',
  'function maxStake() view returns (uint128)',
  'function resolutionGrace() view returns (uint40)',
  'function isAttestor(address) view returns (bool)',
  'function totalLocked() view returns (uint256)',
  'event GoalCreated(uint256 indexed goalId, address indexed creator, uint8 kind, uint128 stake, uint40 startAt, uint40 endAt, uint16 lockDays, bytes32 metadataHash)',
  'event GoalResolved(uint256 indexed goalId, bool indexed success, address indexed attestor, bytes32 evidenceHash, uint40 unlockAt)',
  'event GoalCancelled(uint256 indexed goalId, address indexed creator, uint128 amount)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** `WillFolksEscrow.GoalState`. */
export const ONCHAIN_STATE = { none: 0, active: 1, succeeded: 2, failed: 3, claimed: 4, expired: 5, cancelled: 6 } as const;

const GOAL_KIND_CODE = { alarm: 0, app_timer: 1, locator: 2, ai: 3 } as const;

export interface EscrowParams {
  chainId: number;
  contract: Address;
  token: Address;
  /** Stake in token units (6 decimals), as a decimal string. */
  stake: string;
  startAt: number;
  endAt: number;
  lockDays: number;
  kind: number;
  metadataHash: Hex;
}

export interface OnchainGoal {
  creator: Address;
  startAt: number;
  endAt: number;
  lockDays: number;
  stake: bigint;
  unlockAt: number;
  kind: number;
  state: number;
  metadataHash: Hex;
}

export const toUnits = (amount: number) => BigInt(Math.round(amount * USDC_UNITS));
export const fromUnits = (units: bigint) => Number(units) / USDC_UNITS;

/** Wraps every call to the chain: viem client, the attestor key and the relayer (treasury) key. */
@Injectable()
export class ChainService {
  private readonly log = new Logger(ChainService.name);
  private publicClient?: PublicClient;
  private relayer?: WalletClient;
  private queue: Promise<unknown> = Promise.resolve();

  get enabled(): boolean {
    return env.chain.enabled;
  }

  private get chain() {
    return defineChain({
      id: env.chain.id,
      name: env.chain.name,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [env.chain.rpcUrl] } },
    });
  }

  private get client(): PublicClient {
    this.requireEnabled();
    return (this.publicClient ??= createPublicClient({ chain: this.chain, transport: http(env.chain.rpcUrl) }) as PublicClient);
  }

  private get treasury() {
    if (!env.chain.treasuryKey) throw new ServiceUnavailableException('TREASURY_PRIVATE_KEY is not configured');
    return privateKeyToAccount(this.hex(env.chain.treasuryKey));
  }

  private get attestor() {
    if (!env.chain.attestorKey) throw new ServiceUnavailableException('ATTESTOR_PRIVATE_KEY is not configured');
    return privateKeyToAccount(this.hex(env.chain.attestorKey));
  }

  private get wallet(): WalletClient {
    return (this.relayer ??= createWalletClient({
      account: this.treasury,
      chain: this.chain,
      transport: http(env.chain.rpcUrl),
    }));
  }

  private hex(key: string): Hex {
    return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  }

  private requireEnabled() {
    if (!env.chain.enabled) throw new ServiceUnavailableException({ code: 'CHAIN_DISABLED', message: 'On-chain escrow is disabled' });
    if (!isAddress(env.chain.escrow) || !isAddress(env.chain.usdc)) {
      throw new ServiceUnavailableException('ESCROW_ADDRESS and USDC_ADDRESS must be configured');
    }
  }

  /** Serialises transactions sent from the relayer so their nonces never collide. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Public RPC endpoints balance load across nodes, and one that is a block behind answers
   * `estimateGas` with a revert the next node would not give. Retrying a few times absorbs it;
   * a revert that is real fails every attempt and is thrown after the last.
   */
  private async withRetry<T>(label: string, job: () => Promise<T>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await job();
      } catch (error) {
        if (attempt >= attempts) throw error;
        this.log.warn(`${label}: attempt ${attempt} failed, retrying`);
        await new Promise((done) => setTimeout(done, 1_500 * attempt));
      }
    }
  }

  // ---------------------------------------------------------------- reading

  async config() {
    if (!env.chain.enabled) return { enabled: false as const };
    const [maxStake, grace] = await Promise.all([
      this.client.readContract({ address: env.chain.escrow as Address, abi: ESCROW_ABI, functionName: 'maxStake' }),
      this.client.readContract({ address: env.chain.escrow as Address, abi: ESCROW_ABI, functionName: 'resolutionGrace' }),
    ]);
    return {
      enabled: true as const,
      name: env.chain.name,
      chainId: env.chain.id,
      rpcUrl: env.chain.rpcUrl,
      explorerUrl: env.chain.explorerUrl,
      usdc: getAddress(env.chain.usdc),
      escrow: getAddress(env.chain.escrow),
      attestor: this.attestor.address,
      maxStake: fromUnits(maxStake),
      resolutionGraceSeconds: Number(grace),
      faucet: { usdc: env.chain.faucetUsdc, gasMon: env.chain.faucetGasMon },
      demoGoalSeconds: env.chain.goalSeconds,
    };
  }

  async maxStake(): Promise<number> {
    const units = await this.client.readContract({ address: env.chain.escrow as Address, abi: ESCROW_ABI, functionName: 'maxStake' });
    return fromUnits(units);
  }

  async usdcBalance(address: string): Promise<number> {
    const units = await this.client.readContract({
      address: env.chain.usdc as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [getAddress(address)],
    });
    return fromUnits(units);
  }

  async nativeBalance(address: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(address) });
  }

  async getGoal(escrowGoalId: bigint): Promise<OnchainGoal> {
    const goal = await this.client.readContract({
      address: env.chain.escrow as Address,
      abi: ESCROW_ABI,
      functionName: 'getGoal',
      args: [escrowGoalId],
    });
    return {
      creator: goal.creator,
      startAt: Number(goal.startAt),
      endAt: Number(goal.endAt),
      lockDays: Number(goal.lockDays),
      stake: goal.stake,
      unlockAt: Number(goal.unlockAt),
      kind: Number(goal.kind),
      state: Number(goal.state),
      metadataHash: goal.metadataHash,
    };
  }

  async blockTimestamp(): Promise<number> {
    const block = await this.client.getBlock();
    return Number(block.timestamp);
  }

  // -------------------------------------------------------- goal parameters

  /** Hash that pins the goal's configuration inside the contract. */
  metadataHash(goal: {
    id: string;
    kind: string;
    title: string;
    stakeAmount: number;
    startDate: string;
    endDate: string;
    extraLockDays: number;
  }): Hex {
    return keccak256(
      stringToHex(
        JSON.stringify({
          v: 1,
          goal: goal.id,
          kind: goal.kind,
          title: goal.title,
          stake: goal.stakeAmount,
          start: goal.startDate,
          end: goal.endDate,
          lockDays: goal.extraLockDays,
        }),
      ),
    );
  }

  /**
   * The window a goal gets on the chain. It ends at the end of `endDate` in every time zone
   * (UTC + 12 h of slack), or `goalSeconds` after it starts in demo mode. Chain time is used
   * so a node whose clock drifts from the server's still accepts the window.
   */
  async prepareWindow(goal: { startDate: string; endDate: string }): Promise<{ startAt: number; endAt: number }> {
    const now = await this.blockTimestamp();
    const dayStart = Math.floor(Date.parse(`${goal.startDate}T00:00:00Z`) / 1000);
    const startAt = Math.max(dayStart, now);
    const endAt =
      env.chain.goalSeconds > 0
        ? startAt + env.chain.goalSeconds + 120
        : Math.floor(Date.parse(`${goal.endDate}T00:00:00Z`) / 1000) + 36 * 3600;
    return { startAt, endAt };
  }

  /** What the user's wallet has to submit to `createGoal`, for a window stored with the goal. */
  escrowParams(
    goal: {
      id: string;
      kind: keyof typeof GOAL_KIND_CODE;
      title: string;
      stakeAmount: number;
      startDate: string;
      endDate: string;
      extraLockDays: number;
    },
    window: { startAt: number; endAt: number },
  ): EscrowParams {
    return {
      chainId: env.chain.id,
      contract: getAddress(env.chain.escrow),
      token: getAddress(env.chain.usdc),
      stake: toUnits(goal.stakeAmount).toString(),
      startAt: window.startAt,
      endAt: window.endAt,
      lockDays: goal.extraLockDays,
      kind: GOAL_KIND_CODE[goal.kind],
      metadataHash: this.metadataHash(goal),
    };
  }

  // ----------------------------------------------- user transactions (verify)

  /** Proves from the receipt that `txHash` created exactly the goal that was prepared. */
  async verifyCreate(txHash: string, expected: { creator: string; params: EscrowParams }) {
    if (!isHex(txHash) || txHash.length !== 66) throw new BadRequestException('txHash must be a 32-byte hex string');
    const receipt = await this.waitForReceipt(txHash);
    if (receipt.status !== 'success') throw new BadRequestException({ code: 'TX_REVERTED', message: 'The transaction reverted' });

    for (const entry of receipt.logs) {
      if (getAddress(entry.address) !== getAddress(env.chain.escrow)) continue;
      try {
        const event = decodeEventLog({ abi: ESCROW_ABI, data: entry.data, topics: entry.topics });
        if (event.eventName !== 'GoalCreated') continue;
        const { goalId, creator, stake, endAt, lockDays, kind, metadataHash, startAt } = event.args;
        const { params } = expected;
        const matches =
          getAddress(creator) === getAddress(expected.creator) &&
          stake.toString() === params.stake &&
          Number(endAt) === params.endAt &&
          Number(lockDays) === params.lockDays &&
          Number(kind) === params.kind &&
          metadataHash === params.metadataHash;
        if (!matches) {
          throw new BadRequestException({ code: 'TX_MISMATCH', message: 'The transaction does not match the prepared goal' });
        }
        return { escrowGoalId: goalId, startAt: Number(startAt), endAt: Number(endAt) };
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
      }
    }
    throw new BadRequestException({ code: 'TX_NO_EVENT', message: 'The transaction did not create a goal in WillFolksEscrow' });
  }

  async verifyCancel(txHash: string, expected: { escrowGoalId: bigint; creator: string }) {
    if (!isHex(txHash) || txHash.length !== 66) throw new BadRequestException('txHash must be a 32-byte hex string');
    const receipt = await this.waitForReceipt(txHash);
    if (receipt.status !== 'success') throw new BadRequestException({ code: 'TX_REVERTED', message: 'The transaction reverted' });
    for (const entry of receipt.logs) {
      if (getAddress(entry.address) !== getAddress(env.chain.escrow)) continue;
      try {
        const event = decodeEventLog({ abi: ESCROW_ABI, data: entry.data, topics: entry.topics });
        if (
          event.eventName === 'GoalCancelled' &&
          event.args.goalId === expected.escrowGoalId &&
          getAddress(event.args.creator) === getAddress(expected.creator)
        ) {
          return true;
        }
      } catch {
        // Not an escrow event.
      }
    }
    throw new BadRequestException({ code: 'TX_NO_EVENT', message: 'The transaction did not cancel this goal' });
  }

  private async waitForReceipt(hash: Hex) {
    try {
      return await this.client.waitForTransactionReceipt({ hash, timeout: 45_000 });
    } catch {
      throw new BadRequestException({ code: 'TX_NOT_FOUND', message: 'Transaction not found or not confirmed yet' });
    }
  }

  // --------------------------------------------------------- wallet linking

  linkMessage(userId: string): string {
    return `WillFolks wallet link\nuser:${userId}`;
  }

  async verifyWalletOwnership(userId: string, address: string, signature: string): Promise<Address> {
    if (!isAddress(address)) throw new BadRequestException('Invalid wallet address');
    const valid = await verifyMessage({
      address: getAddress(address),
      message: this.linkMessage(userId),
      signature: signature as Hex,
    }).catch(() => false);
    if (!valid) throw new BadRequestException({ code: 'BAD_SIGNATURE', message: 'The signature does not match the wallet' });
    return getAddress(address);
  }

  // -------------------------------------------------- relayer (backend txs)

  /** Sends test USDC and gas from the treasury. */
  faucet(to: string): Promise<{ usdcTx: Hex; gasTx: Hex }> {
    return this.enqueue(async () => {
      const address = getAddress(to);
      const gasTx = await this.withRetry('faucet gas', () =>
        this.wallet.sendTransaction({
          account: this.treasury,
          chain: this.chain,
          to: address,
          value: parseEther(env.chain.faucetGasMon),
        }),
      );
      await this.client.waitForTransactionReceipt({ hash: gasTx, timeout: 45_000 });
      const usdcTx = await this.withRetry('faucet usdc', () =>
        this.wallet.writeContract({
          account: this.treasury,
          chain: this.chain,
          address: env.chain.usdc as Address,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [address, toUnits(env.chain.faucetUsdc)],
        }),
      );
      await this.client.waitForTransactionReceipt({ hash: usdcTx, timeout: 45_000 });
      return { usdcTx, gasTx };
    });
  }

  /** Signs the verdict as the attestor and submits it from the relayer. */
  resolve(escrowGoalId: bigint, success: boolean, evidence: object) {
    return this.enqueue(async () => {
      const evidenceHash = keccak256(stringToHex(JSON.stringify(evidence)));
      // Chain time, not the server's: the contract compares against block.timestamp.
      const validUntil = (await this.blockTimestamp()) + 15 * 60;
      const attestor = this.attestor;
      const signature = await attestor.signTypedData({
        domain: {
          name: 'WillFolksEscrow',
          version: '1',
          chainId: env.chain.id,
          verifyingContract: env.chain.escrow as Address,
        },
        types: {
          Resolution: [
            { name: 'goalId', type: 'uint256' },
            { name: 'success', type: 'bool' },
            { name: 'evidenceHash', type: 'bytes32' },
            { name: 'validUntil', type: 'uint40' },
          ],
        },
        primaryType: 'Resolution',
        message: { goalId: escrowGoalId, success, evidenceHash, validUntil },
      });
      const hash = await this.withRetry('resolve', () =>
        this.wallet.writeContract({
          account: this.treasury,
          chain: this.chain,
          address: env.chain.escrow as Address,
          abi: ESCROW_ABI,
          functionName: 'resolve',
          args: [escrowGoalId, success, evidenceHash, validUntil, attestor.address, signature],
        }),
      );
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 45_000 });
      if (receipt.status !== 'success') throw new Error(`resolve reverted: ${hash}`);
      this.log.log(`resolved escrow goal ${escrowGoalId} success=${success} tx=${hash}`);
      return { txHash: hash, evidenceHash };
    });
  }

  claim(escrowGoalId: bigint, fn: 'claim' | 'reclaim' = 'claim') {
    return this.enqueue(async () => {
      const hash = await this.withRetry(fn, () =>
        this.wallet.writeContract({
          account: this.treasury,
          chain: this.chain,
          address: env.chain.escrow as Address,
          abi: ESCROW_ABI,
          functionName: fn,
          args: [escrowGoalId],
        }),
      );
      const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 45_000 });
      if (receipt.status !== 'success') throw new Error(`${fn} reverted: ${hash}`);
      this.log.log(`${fn} escrow goal ${escrowGoalId} tx=${hash}`);
      return { txHash: hash };
    });
  }

  explorerTx(hash: string): string {
    return `${env.chain.explorerUrl}/tx/${hash}`;
  }
}
