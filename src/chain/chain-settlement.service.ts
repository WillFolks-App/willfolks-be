import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { Goal, GoalCheckin, WalletTransaction } from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { ChainService, ONCHAIN_STATE } from './chain.service.js';

/**
 * Carries decisions the database already made onto the chain: the attestor signs a verdict
 * for finished goals, locked stakes are claimed when their lock ends, and a stake nobody
 * resolved is reclaimed once the grace period is over.
 *
 * The chain is the source of truth for funds, so every step first reads the goal's on-chain
 * state: a transaction that timed out but landed is picked up instead of being sent twice.
 */
@Injectable()
export class ChainSettlementService {
  private readonly log = new Logger(ChainSettlementService.name);
  private readonly busy = new Set<string>();
  private running?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Starts a pass without waiting for it; call it right after the database changes. */
  kick(): void {
    if (!env.chain.enabled) return;
    void this.tick().catch((error) => this.log.warn(`settlement pass failed: ${String(error)}`));
  }

  /** One pass over every goal with something pending on the chain. Passes never overlap. */
  tick(): Promise<void> {
    if (!env.chain.enabled) return Promise.resolve();
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const goals = await this.dataSource.manager.find(Goal, {
      where: { escrowState: In(['active', 'failed_locked']) },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    if (!goals.length) return;
    const now = await this.chain.blockTimestamp();
    for (const goal of goals) {
      if (this.busy.has(goal.id)) continue;
      this.busy.add(goal.id);
      try {
        await this.settle(goal, now);
      } catch (error) {
        await this.fail(goal, error);
      } finally {
        this.busy.delete(goal.id);
      }
    }
  }

  private async settle(goal: Goal, now: number): Promise<void> {
    if (!goal.escrowGoalId) return;
    const escrowGoalId = BigInt(goal.escrowGoalId);
    const onchain = await this.chain.getGoal(escrowGoalId);

    // Already moved on the chain (a previous attempt landed, or the user acted): follow it.
    if (onchain.state !== ONCHAIN_STATE.active && !(onchain.state === ONCHAIN_STATE.failed && goal.escrowState === 'failed_locked')) {
      await this.follow(goal, onchain.state, onchain.unlockAt);
      return;
    }

    if (goal.escrowState === 'failed_locked') {
      if (now >= onchain.unlockAt) await this.release(goal, 'claim');
      return;
    }

    const graceClosed = now > onchain.endAt + (await this.graceSeconds());
    if (goal.status === 'failed' && now >= onchain.startAt) return this.verdict(goal, false);
    if (goal.status === 'completed' && now >= onchain.endAt) return this.verdict(goal, true);
    if (graceClosed) await this.release(goal, 'reclaim');
  }

  private graceSeconds = (() => {
    let cached: number | undefined;
    return async () => (cached ??= (await this.chain.config() as { resolutionGraceSeconds?: number }).resolutionGraceSeconds ?? 86_400);
  })();

  private async verdict(goal: Goal, success: boolean): Promise<void> {
    const checkins = await this.dataSource.manager.find(GoalCheckin, {
      where: { goalId: goal.id, userId: goal.ownerId },
      order: { scheduledFor: 'ASC' },
    });
    const evidence = {
      v: 1,
      goal: goal.id,
      escrowGoalId: goal.escrowGoalId,
      outcome: success ? 'success' : 'fail',
      maxAttempts: goal.maxAttempts,
      checkins: checkins.map((checkin) => ({
        day: checkin.scheduledFor,
        result: checkin.result,
        source: checkin.source,
        value: checkin.measuredValue,
        unit: checkin.measuredUnit,
      })),
    };

    const { txHash } = await this.chain.resolve(BigInt(goal.escrowGoalId!), success, evidence);
    const onchain = await this.chain.getGoal(BigInt(goal.escrowGoalId!));

    await this.dataSource.transaction(async (manager) => {
      await manager.update(Goal, { id: goal.id }, {
        escrowState: success ? 'succeeded' : 'failed_locked',
        escrowResolveTxHash: txHash,
        escrowEvidence: evidence as never,
        escrowUnlockAt: success ? null : new Date(onchain.unlockAt * 1000),
        escrowError: null,
        escrowAttempts: 0,
        resolvedAt: new Date(),
      });
      if (success) await this.payout(manager, goal, 'stake_release', txHash, 'escrowReleased');
    });
  }

  private async release(goal: Goal, fn: 'claim' | 'reclaim'): Promise<void> {
    const { txHash } = await this.chain.claim(BigInt(goal.escrowGoalId!), fn);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Goal, { id: goal.id }, {
        escrowState: fn === 'claim' ? 'claimed' : 'expired',
        escrowClaimTxHash: txHash,
        // A stake nobody resolved ends the goal without a verdict.
        ...(fn === 'reclaim' ? { status: 'cancelled' as const, resolvedAt: new Date() } : {}),
        escrowError: null,
        escrowAttempts: 0,
      });
      await this.payout(manager, goal, 'stake_release', txHash, fn === 'claim' ? 'escrowUnlocked' : 'escrowReleased');
    });
  }

  /** The chain moved without us (or we lost the receipt): bring the database in line. */
  private async follow(goal: Goal, state: number, unlockAt: number): Promise<void> {
    const map: Partial<Record<number, Goal['escrowState']>> = {
      [ONCHAIN_STATE.succeeded]: 'succeeded',
      [ONCHAIN_STATE.failed]: 'failed_locked',
      [ONCHAIN_STATE.claimed]: 'claimed',
      [ONCHAIN_STATE.expired]: 'expired',
      [ONCHAIN_STATE.cancelled]: 'cancelled',
    };
    const next = map[state];
    if (!next || next === goal.escrowState) return;
    this.log.warn(`goal ${goal.id}: following on-chain state ${next}`);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(Goal, { id: goal.id }, {
        escrowState: next,
        escrowUnlockAt: next === 'failed_locked' ? new Date(unlockAt * 1000) : goal.escrowUnlockAt,
        escrowError: null,
        escrowAttempts: 0,
        ...(next === 'cancelled' || next === 'expired' ? { status: 'cancelled' as const, resolvedAt: new Date() } : {}),
      });
      const returned = next === 'succeeded' || next === 'claimed' || next === 'expired' || next === 'cancelled';
      if (returned) await this.payout(manager, goal, 'stake_release', null, 'escrowReleased');
    });
  }

  /** Records the return of a stake once, with the hash of the transaction that moved it. */
  private async payout(
    manager: EntityManager,
    goal: Goal,
    type: 'stake_release',
    txHash: string | null,
    copy: 'escrowReleased' | 'escrowUnlocked',
  ): Promise<void> {
    const already = await manager.findOneBy(WalletTransaction, { goalId: goal.id, userId: goal.ownerId, type });
    if (already) return;
    await this.wallet.record(manager, {
      userId: goal.ownerId,
      goalId: goal.id,
      type,
      amount: goal.stakeAmount,
      method: 'crypto',
      txHash,
      note: goal.title,
    });
    await this.notifications.push(
      manager,
      goal.ownerId,
      'goal_result',
      copy,
      { title: goal.title, amount: goal.stakeAmount },
      { goalId: goal.id, txHash },
    );
  }

  private async fail(goal: Goal, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(`goal ${goal.id}: ${message.split('\n')[0]}`);
    await this.dataSource.manager.update(Goal, { id: goal.id }, {
      escrowError: message.slice(0, 500),
      escrowAttempts: Math.min(goal.escrowAttempts + 1, 32_000),
    });
  }
}
