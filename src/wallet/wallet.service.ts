import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { round6, simulatedTxHash } from '../common/db.js';
import { ChainService } from '../chain/chain.service.js';
import { TxMethod, TxType, User, WalletTransaction } from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export interface Balance {
  available: number;
  inEscrow: number;
  penalized: number;
  currency: 'USDC';
}

interface RecordInput {
  userId: string;
  type: TxType;
  amount: number;
  method?: TxMethod;
  goalId?: string | null;
  /** `undefined` generates a simulated hash; `null` records a movement whose hash is unknown. */
  txHash?: string | null;
  note?: string | null;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly chain: ChainService,
  ) {}

  async balance(userId: string, manager: EntityManager = this.dataSource.manager): Promise<Balance> {
    const ledger = await this.ledgerBalance(userId, manager);
    if (!env.chain.enabled) return ledger;
    // With the chain on, what is spendable is what the user's wallet really holds.
    const user = await manager.findOne(User, { where: { id: userId }, select: { id: true, walletAddress: true } });
    if (!user?.walletAddress) return { ...ledger, available: 0 };
    try {
      return { ...ledger, available: await this.chain.usdcBalance(user.walletAddress) };
    } catch {
      return ledger;
    }
  }

  private async ledgerBalance(userId: string, manager: EntityManager): Promise<Balance> {
    const [row] = await manager.query<{ available: string; in_escrow: string; penalized: string }[]>(
      'SELECT available, in_escrow, penalized FROM v_user_balances WHERE user_id = $1',
      [userId],
    );
    return {
      available: Number(row?.available ?? 0),
      inEscrow: Number(row?.in_escrow ?? 0),
      penalized: Number(row?.penalized ?? 0),
      currency: 'USDC',
    };
  }

  /** Serialises money movements of one user for the rest of the transaction. */
  async lockUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  }

  /** Fails unless the user can cover `amount`. Call after `lockUser`. */
  async assertFunds(manager: EntityManager, userId: string, amount: number): Promise<void> {
    const { available } = await this.balance(userId, manager);
    if (available < amount) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_FUNDS',
        message: `Available balance is ${available} USDC, ${amount} USDC needed`,
        available,
      });
    }
  }

  async record(manager: EntityManager, input: RecordInput): Promise<WalletTransaction> {
    const user = await manager.findOneOrFail(User, { where: { id: input.userId }, select: { id: true, chain: true } });
    const onChain = input.method !== 'fiat';
    const { identifiers } = await manager.insert(WalletTransaction, {
      userId: input.userId,
      goalId: input.goalId ?? null,
      type: input.type,
      method: input.method ?? 'internal',
      amount: round6(input.amount),
      status: 'confirmed',
      chain: onChain ? (env.chain.enabled && input.txHash ? env.chain.name : user.chain) : null,
      txHash: input.txHash !== undefined ? input.txHash : onChain ? simulatedTxHash() : null,
      note: input.note?.slice(0, 160) ?? null,
      confirmedAt: new Date(),
    });
    return manager.findOneByOrFail(WalletTransaction, { id: identifiers[0].id as string });
  }

  deposit(userId: string, amount: number, method: 'crypto' | 'fiat'): Promise<WalletTransaction> {
    return this.dataSource.transaction(async (manager) => {
      const tx = await this.record(manager, { userId, type: 'deposit', amount, method });
      await this.notifications.push(manager, userId, 'wallet', 'deposit', { amount, reference: tx.referenceCode }, { transactionId: tx.id });
      return tx;
    });
  }

  withdraw(userId: string, amount: number, note?: string): Promise<WalletTransaction> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockUser(manager, userId);
      await this.assertFunds(manager, userId, amount);
      const tx = await this.record(manager, { userId, type: 'withdrawal', amount, method: 'crypto', note });
      await this.notifications.push(manager, userId, 'wallet', 'withdrawal', { amount, reference: tx.referenceCode }, { transactionId: tx.id });
      return tx;
    });
  }

  list(userId: string, limit: number): Promise<WalletTransaction[]> {
    return this.dataSource.manager.find(WalletTransaction, {
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async get(userId: string, id: string): Promise<WalletTransaction> {
    const tx = await this.dataSource.manager.findOneBy(WalletTransaction, { id, userId });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }
}
