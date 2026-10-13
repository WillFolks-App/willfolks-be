import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';

import { ChainSettlementService } from '../chain/chain-settlement.service.js';
import { ChainService, type EscrowParams } from '../chain/chain.service.js';
import { defined, round6 } from '../common/db.js';
import { mediaUrl, publicUser } from '../common/serialize.js';
import {
  type CheckinResult,
  Friendship,
  Goal,
  GoalAiSettings,
  GoalAlarmSettings,
  GoalAppTimerSettings,
  GoalCheckin,
  type GoalKind,
  GoalLocationSettings,
  GoalParticipant,
  Proof,
  User,
  WalletTransaction,
} from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PetService } from '../pet/pet.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { CreateCheckinDto, CreateGoalDto, CreateProofDto, ReviewProofDto, UpdateGoalDto } from './goals.dto.js';

const GOAL_RELATIONS = { alarm: true, appTimer: true, location: true, ai: true, participants: { user: true } } as const;

/** Setting block each kind of goal must carry. */
const SETTINGS_KEY = { alarm: 'alarm', app_timer: 'appTimer', locator: 'location', ai: 'ai' } as const satisfies Record<
  GoalKind,
  keyof CreateGoalDto
>;

interface Progress {
  successCount: number;
  failCount: number;
  pendingCount: number;
  /** The user's most recent check, so the device knows which days are already settled. */
  lastCheckin: { scheduledFor: string; result: CheckinResult } | null;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const today = () => isoDate(new Date());
const NO_PROGRESS: Progress = { successCount: 0, failCount: 0, pendingCount: 0, lastCheckin: null };

/** Great-circle distance in metres. */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly pets: PetService,
    private readonly chain: ChainService,
    private readonly settlement: ChainSettlementService,
  ) {}

  // ---------------------------------------------------------------- reading

  async list(userId: string) {
    await this.settleExpired(userId);
    this.settlement.kick();
    const { manager } = this.dataSource;
    const memberships = await manager.find(GoalParticipant, {
      where: { userId, status: In(['invited', 'accepted']) },
      select: { goalId: true, userId: true },
    });
    if (!memberships.length) return [];

    const goals = await manager.find(Goal, {
      where: { id: In(memberships.map((membership) => membership.goalId)), status: In(['active', 'paused', 'completed', 'failed']) },
      relations: GOAL_RELATIONS,
      order: { createdAt: 'DESC' },
    });
    const progress = await this.progress(manager, userId, goals.map((goal) => goal.id));
    return goals.map((goal) => this.view(goal, userId, progress.get(goal.id)));
  }

  async get(userId: string, goalId: string, manager: EntityManager = this.dataSource.manager, withParams = false) {
    const goal = await this.load(manager, userId, goalId);
    const progress = await this.progress(manager, userId, [goalId]);
    const view = this.view(goal, userId, progress.get(goalId));
    if (!withParams || goal.escrowState !== 'pending') return view;
    // The exact transaction the user's wallet must submit.
    return { ...view, escrowParams: this.storedParams(goal) };
  }

  /** The parameters prepared at creation, rebuilt from what the goal stored. */
  private storedParams(goal: Goal): EscrowParams {
    return this.chain.escrowParams(goal, {
      startAt: Math.floor(goal.escrowStartAt!.getTime() / 1000),
      endAt: Math.floor(goal.escrowEndAt!.getTime() / 1000),
    });
  }

  async listCheckins(userId: string, goalId: string) {
    await this.load(this.dataSource.manager, userId, goalId);
    return this.dataSource.manager.find(GoalCheckin, {
      where: { goalId },
      order: { scheduledFor: 'DESC', occurredAt: 'DESC' },
      take: 200,
    });
  }

  // ---------------------------------------------------------------- writing

  async create(userId: string, dto: CreateGoalDto) {
    const settingsKey = SETTINGS_KEY[dto.kind];
    if (!dto[settingsKey]) throw new BadRequestException(`"${settingsKey}" settings are required for a ${dto.kind} goal`);

    const startDate = dto.startDate ?? today();
    if (dto.endDate < startDate) throw new BadRequestException('endDate must not be before startDate');

    const invitees = (dto.participantIds ?? []).filter((id) => id !== userId);
    const judge = dto.kind === 'ai' && dto.ai?.verifier === 'friend' ? dto.ai.verifierUserId : undefined;
    if (dto.kind === 'ai' && dto.ai?.verifier === 'friend' && !judge) {
      throw new BadRequestException('verifierUserId is required when the verifier is a friend');
    }

    const onChain = this.chain.enabled;
    let wallet: string | null = null;
    if (onChain) {
      // With the escrow on the chain the stake is locked by the user's own wallet.
      if (invitees.length) {
        throw new BadRequestException({ code: 'GROUP_NOT_SUPPORTED', message: 'Shared goals are not available with the on-chain escrow yet' });
      }
      if ((dto.extraLockDays ?? 7) > 90) {
        throw new BadRequestException({ code: 'LOCK_TOO_LONG', message: 'extraLockDays cannot exceed 90 with the on-chain escrow' });
      }
      const owner = await this.dataSource.manager.findOneByOrFail(User, { id: userId });
      wallet = owner.walletAddress;
      if (!wallet) throw new BadRequestException({ code: 'WALLET_REQUIRED', message: 'Link a wallet before creating a goal' });
      const [maxStake, balance] = await Promise.all([this.chain.maxStake(), this.chain.usdcBalance(wallet)]);
      if (dto.stakeAmount > maxStake) {
        throw new BadRequestException({ code: 'STAKE_ABOVE_CAP', message: `The escrow accepts at most ${maxStake} USDC per goal`, max: maxStake });
      }
      if (balance < dto.stakeAmount) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_FUNDS',
          message: `Your wallet holds ${balance} USDC, ${dto.stakeAmount} USDC needed`,
          available: balance,
        });
      }
    }

    const goalId = await this.dataSource.transaction(async (manager) => {
      await this.assertFriends(manager, userId, judge ? [...invitees, judge] : invitees);
      if (!onChain) {
        await this.wallet.lockUser(manager, userId);
        await this.wallet.assertFunds(manager, userId, dto.stakeAmount);
      }

      const { identifiers } = await manager.insert(Goal, {
        ownerId: userId,
        kind: dto.kind,
        title: dto.title.trim(),
        description: dto.description ?? null,
        status: onChain ? 'draft' : 'active',
        ...(onChain ? { escrowState: 'pending' as const } : {}),
        stakeAmount: dto.stakeAmount,
        startDate,
        endDate: dto.endDate,
        repeatDays: dto.repeatDays ? [...dto.repeatDays].sort() : undefined,
        notificationsEnabled: dto.notificationsEnabled,
        maxAttempts: dto.maxAttempts,
        extraLockDays: dto.extraLockDays,
        devTipPercent: dto.devTipPercent,
        isGroup: invitees.length > 0,
        groupMode: invitees.length > 0 ? (dto.groupMode ?? 'coop') : null,
      });
      const id = identifiers[0].id as string;

      if (dto.kind === 'alarm') await manager.insert(GoalAlarmSettings, { goalId: id, ...dto.alarm });
      if (dto.kind === 'app_timer') await manager.insert(GoalAppTimerSettings, { goalId: id, ...dto.appTimer });
      if (dto.kind === 'locator') await manager.insert(GoalLocationSettings, { goalId: id, ...dto.location });
      if (dto.kind === 'ai') {
        await manager.insert(GoalAiSettings, {
          goalId: id,
          prompt: dto.ai!.prompt,
          verifier: dto.ai!.verifier ?? 'ai',
          verifierUserId: judge ?? null,
        });
      }

      const now = new Date();
      await manager.insert(GoalParticipant, [
        { goalId: id, userId, role: 'owner', status: 'accepted', stakeAmount: onChain ? 0 : dto.stakeAmount, respondedAt: now },
        ...invitees.map((invitee) => ({ goalId: id, userId: invitee, role: 'participant' as const, status: 'invited' as const })),
      ]);

      if (onChain) {
        // The stake is locked when the user's transaction is confirmed (see `confirmEscrow`).
        const saved = await manager.findOneByOrFail(Goal, { id });
        const window = await this.chain.prepareWindow(saved);
        const params = this.chain.escrowParams(saved, window);
        await manager.update(Goal, { id }, {
          escrowContract: params.contract,
          escrowChainId: params.chainId,
          escrowStartAt: new Date(params.startAt * 1000),
          escrowEndAt: new Date(params.endAt * 1000),
          escrowMetadataHash: params.metadataHash,
        });
        return id;
      }

      const tx = await this.wallet.record(manager, {
        userId,
        goalId: id,
        type: 'stake_lock',
        amount: dto.stakeAmount,
        note: dto.title,
      });
      await manager.update(Goal, { id }, { escrowTxHash: tx.txHash });

      const owner = await manager.findOneByOrFail(User, { id: userId });
      const params = { title: dto.title, amount: dto.stakeAmount, name: owner.displayName };
      await this.pets.apply(userId, 'staked', manager);
      await this.notifications.push(manager, userId, 'goal_created', 'goalCreated', params, { goalId: id });
      for (const invitee of invitees) {
        await this.notifications.push(manager, invitee, 'goal_invite', 'goalInvite', params, { goalId: id });
      }
      return id;
    });

    return this.get(userId, goalId, undefined, true);
  }

  /**
   * Confirms the transaction the user signed to create the goal on the chain. The receipt is
   * checked against what was prepared, so a client cannot claim a stake it never locked.
   */
  async confirmEscrow(userId: string, goalId: string, txHash: string) {
    const goal = await this.loadOwned(this.dataSource.manager, userId, goalId);
    if (goal.escrowState === 'active' && goal.escrowTxHash === txHash.toLowerCase()) return this.get(userId, goalId);
    if (goal.escrowState !== 'pending') {
      throw new ConflictException({ code: 'ESCROW_NOT_PENDING', message: `The goal's escrow is ${goal.escrowState}` });
    }
    const owner = await this.dataSource.manager.findOneByOrFail(User, { id: userId });
    const params = this.storedParams(goal);
    const created = await this.chain.verifyCreate(txHash, { creator: owner.walletAddress!, params });

    await this.dataSource.transaction(async (manager) => {
      await manager.update(Goal, { id: goalId }, {
        status: 'active',
        escrowState: 'active',
        escrowGoalId: created.escrowGoalId.toString(),
        escrowTxHash: txHash.toLowerCase(),
        escrowStartAt: new Date(created.startAt * 1000),
        escrowEndAt: new Date(created.endAt * 1000),
        escrowError: null,
      });
      await manager.update(GoalParticipant, { goalId, userId }, { stakeAmount: goal.stakeAmount });
      await this.wallet.record(manager, {
        userId,
        goalId,
        type: 'stake_lock',
        amount: goal.stakeAmount,
        method: 'crypto',
        txHash: txHash.toLowerCase(),
        note: goal.title,
      });
      await this.pets.apply(userId, 'staked', manager);
      await this.notifications.push(
        manager,
        userId,
        'goal_created',
        'goalCreated',
        { title: goal.title, amount: goal.stakeAmount, name: owner.displayName },
        { goalId, txHash },
      );
    });
    return this.get(userId, goalId);
  }

  /** Confirms a `cancel` the user sent to the contract before the goal started. */
  async confirmEscrowCancel(userId: string, goalId: string, txHash: string) {
    const goal = await this.loadOwned(this.dataSource.manager, userId, goalId);
    if (goal.escrowState !== 'active' || !goal.escrowGoalId) {
      throw new ConflictException({ code: 'ESCROW_NOT_ACTIVE', message: `The goal's escrow is ${goal.escrowState}` });
    }
    const owner = await this.dataSource.manager.findOneByOrFail(User, { id: userId });
    await this.chain.verifyCancel(txHash, { escrowGoalId: BigInt(goal.escrowGoalId), creator: owner.walletAddress! });

    await this.dataSource.transaction(async (manager) => {
      await manager.update(Goal, { id: goalId }, {
        status: 'cancelled',
        escrowState: 'cancelled',
        escrowClaimTxHash: txHash.toLowerCase(),
        resolvedAt: new Date(),
      });
      await manager.update(GoalParticipant, { goalId, userId }, { stakeAmount: 0 });
      await this.wallet.record(manager, {
        userId,
        goalId,
        type: 'stake_release',
        amount: goal.stakeAmount,
        method: 'crypto',
        txHash: txHash.toLowerCase(),
        note: goal.title,
      });
      await this.notifications.push(manager, userId, 'goal_result', 'goalCancelled', { title: goal.title, amount: goal.stakeAmount }, { goalId, txHash });
    });
    return this.get(userId, goalId);
  }

  async update(userId: string, goalId: string, dto: UpdateGoalDto) {
    await this.dataSource.transaction(async (manager) => {
      const goal = await this.loadOwned(manager, userId, goalId);
      if (goal.status !== 'active' && goal.status !== 'paused') {
        throw new ConflictException({ code: 'GOAL_CLOSED', message: `A ${goal.status} goal cannot be edited` });
      }
      const { alarm, ...rest } = dto;
      const fields = defined(rest);
      if (fields.repeatDays) fields.repeatDays = [...fields.repeatDays].sort();
      if (Object.keys(fields).length) await manager.update(Goal, { id: goalId }, fields);
      if (alarm) {
        if (goal.kind !== 'alarm') throw new BadRequestException('Only alarm goals have alarm settings');
        await manager.update(GoalAlarmSettings, { goalId }, defined(alarm));
      }
    });
    return this.get(userId, goalId);
  }

  /** Cancels a live goal and gives every remaining stake back. */
  async cancel(userId: string, goalId: string) {
    await this.dataSource.transaction(async (manager) => {
      const goal = await this.loadOwned(manager, userId, goalId);
      if (goal.status !== 'active' && goal.status !== 'paused' && goal.escrowState !== 'pending') {
        throw new ConflictException({ code: 'GOAL_CLOSED', message: `Goal is already ${goal.status}` });
      }
      if (goal.escrowState === 'active') {
        throw new ConflictException({
          code: 'CANCEL_ON_CHAIN',
          message: 'The stake is in the contract: cancel from your wallet before the goal starts, then confirm it',
        });
      }
      if (goal.escrowState === 'pending') {
        // Nothing was ever locked: the draft just closes.
        await manager.update(Goal, { id: goal.id }, { status: 'cancelled', escrowState: 'cancelled', resolvedAt: new Date() });
        return;
      }
      await this.close(manager, goal, 'cancelled', 'goalCancelled');
    });
  }

  async respondInvite(userId: string, goalId: string, accept: boolean) {
    await this.dataSource.transaction(async (manager) => {
      const goal = await this.load(manager, userId, goalId);
      const participant = goal.participants.find((item) => item.userId === userId)!;
      if (participant.status !== 'invited') throw new ConflictException('Invitation already answered');

      if (accept) {
        if (goal.status !== 'active') throw new ConflictException({ code: 'GOAL_NOT_ACTIVE', message: 'Goal is not active' });
        await this.wallet.lockUser(manager, userId);
        await this.wallet.assertFunds(manager, userId, goal.stakeAmount);
        await this.wallet.record(manager, { userId, goalId, type: 'stake_lock', amount: goal.stakeAmount, note: goal.title });
        await this.pets.apply(userId, 'staked', manager);
        await this.notifications.push(
          manager,
          goal.ownerId,
          'goal_invite',
          'inviteAccepted',
          { name: participant.user.displayName, title: goal.title },
          { goalId },
        );
      }
      await manager.update(
        GoalParticipant,
        { goalId, userId },
        { status: accept ? 'accepted' : 'declined', stakeAmount: accept ? goal.stakeAmount : 0, respondedAt: new Date() },
      );
    });
    return accept ? this.get(userId, goalId) : { declined: true };
  }

  // ---------------------------------------------------------------- check-ins

  async checkin(userId: string, goalId: string, dto: CreateCheckinDto) {
    const checkinId = await this.dataSource.transaction(async (manager) => {
      const goal = await this.loadActive(manager, userId, goalId);
      const scheduledFor = this.scheduledDay(goal, dto.scheduledFor);
      const judged = this.judge(goal, dto);

      const existing = await manager.findOneBy(GoalCheckin, { goalId, userId, scheduledFor });
      if (existing && existing.result !== 'pending') {
        // A day's verdict is final, except usage that kept growing past the limit.
        const worsened = existing.result === 'success' && judged.result === 'fail' && dto.source === 'usage';
        if (!worsened) return existing.id;
      }

      const checkin = existing ?? manager.create(GoalCheckin, { goalId, userId, scheduledFor });
      Object.assign(checkin, {
        occurredAt: new Date(),
        result: judged.result,
        source: dto.source,
        measuredValue: judged.measuredValue ?? null,
        measuredUnit: judged.measuredUnit ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        details: dto.details ?? {},
      });
      await manager.save(checkin);
      await this.applyOutcome(manager, goal, userId, judged.result);
      return checkin.id;
    });
    this.settlement.kick();

    return {
      checkin: await this.dataSource.manager.findOneByOrFail(GoalCheckin, { id: checkinId }),
      goal: await this.get(userId, goalId),
    };
  }

  // ---------------------------------------------------------------- proofs

  async submitProof(userId: string, goalId: string, file: Express.Multer.File, dto: CreateProofDto) {
    const proofId = await this.dataSource.transaction(async (manager) => {
      const goal = await this.loadActive(manager, userId, goalId);
      if (goal.kind !== 'ai' || !goal.ai) throw new BadRequestException('Only AI goals take proofs');
      const scheduledFor = this.scheduledDay(goal, dto.scheduledFor);

      let checkin = await manager.findOneBy(GoalCheckin, { goalId, userId, scheduledFor });
      if (checkin && checkin.result !== 'pending') {
        throw new ConflictException({ code: 'ALREADY_RESOLVED', message: `That day is already marked as ${checkin.result}` });
      }
      checkin ??= await manager.save(
        manager.create(GoalCheckin, { goalId, userId, scheduledFor, occurredAt: new Date(), result: 'pending', source: 'proof' }),
      );

      // A friend judge who deleted their account leaves the verdict to the AI.
      const verifier = goal.ai.verifier === 'friend' && goal.ai.verifierUserId ? 'friend' : 'ai';
      const { identifiers } = await manager.insert(Proof, {
        goalId,
        userId,
        checkinId: checkin.id,
        mediaUrl: `/uploads/proofs/${file.filename}`,
        note: dto.note ?? null,
        verifier,
        reviewerId: verifier === 'friend' ? goal.ai.verifierUserId : null,
      });
      const proof = await manager.findOneByOrFail(Proof, { id: identifiers[0].id as string });

      if (verifier === 'ai' && env.aiVerifierMode === 'auto-approve') {
        // Stand-in for the Gemini judge: any proof with a photo passes.
        await this.resolveProof(manager, goal, proof, true, 'Auto-approved: AI verification is simulated in this build.');
      } else if (proof.reviewerId) {
        const author = goal.participants.find((item) => item.userId === userId)!.user;
        await this.notifications.push(
          manager,
          proof.reviewerId,
          'proof_review',
          'proofReview',
          { name: author.displayName, title: goal.title },
          { goalId, proofId: proof.id },
        );
      }
      return proof.id;
    });
    this.settlement.kick();

    return {
      proof: this.proofView(await this.dataSource.manager.findOneByOrFail(Proof, { id: proofId })),
      goal: await this.get(userId, goalId),
    };
  }

  async reviewProof(userId: string, proofId: string, dto: ReviewProofDto) {
    await this.dataSource.transaction(async (manager) => {
      const proof = await manager.findOneBy(Proof, { id: proofId });
      // In `manual` mode the author settles their own AI proofs: a development hook.
      const isJudge = proof?.verifier === 'friend' && proof.reviewerId === userId;
      const isManualAi = proof?.verifier === 'ai' && env.aiVerifierMode === 'manual' && proof.userId === userId;
      if (!proof || (!isJudge && !isManualAi)) throw new NotFoundException('Proof not found');
      if (proof.status !== 'pending') throw new ConflictException(`Proof already ${proof.status}`);

      const goal = await manager.findOneOrFail(Goal, { where: { id: proof.goalId }, relations: GOAL_RELATIONS });
      await this.resolveProof(manager, goal, proof, dto.approved, dto.reason ?? null);
    });
    this.settlement.kick();
    return this.proofView(await this.dataSource.manager.findOneByOrFail(Proof, { id: proofId }));
  }

  async listProofs(userId: string, goalId: string) {
    await this.load(this.dataSource.manager, userId, goalId);
    const proofs = await this.dataSource.manager.find(Proof, { where: { goalId }, order: { createdAt: 'DESC' }, take: 100 });
    return proofs.map((proof) => this.proofView(proof));
  }

  /** Proofs waiting for this user's verdict as a friend judge. */
  async pendingReviews(userId: string) {
    const proofs = await this.dataSource.manager.find(Proof, {
      where: { reviewerId: userId, status: 'pending' },
      relations: { goal: { ai: true }, user: true },
      order: { createdAt: 'ASC' },
    });
    return proofs.map((proof) => ({
      ...this.proofView(proof),
      goalTitle: proof.goal.title,
      prompt: proof.goal.ai?.prompt ?? null,
      user: publicUser(proof.user),
    }));
  }

  // ---------------------------------------------------------------- internals

  private async resolveProof(manager: EntityManager, goal: Goal, proof: Proof, approved: boolean, reason: string | null) {
    proof.status = approved ? 'approved' : 'rejected';
    proof.verdictReason = reason;
    proof.reviewedAt = new Date();
    await manager.save(proof);

    const result: CheckinResult = approved ? 'success' : 'fail';
    if (proof.checkinId) await manager.update(GoalCheckin, { id: proof.checkinId }, { result, occurredAt: new Date() });
    await this.applyOutcome(manager, goal, proof.userId, result);
  }

  /** Decides a check-in from what the device measured. */
  private judge(goal: Goal, dto: CreateCheckinDto): { result: 'success' | 'fail'; measuredValue?: number; measuredUnit?: string } {
    switch (goal.kind) {
      case 'alarm': {
        if (dto.source !== 'alarm' && dto.source !== 'manual') throw new BadRequestException('Alarm goals take alarm check-ins');
        if (!dto.result) throw new BadRequestException('result is required for alarm check-ins');
        return { result: dto.result, measuredValue: dto.measuredValue, measuredUnit: dto.measuredUnit ?? 'seconds' };
      }
      case 'app_timer': {
        if (dto.source !== 'usage' || dto.measuredValue === undefined) {
          throw new BadRequestException('App timer goals take usage check-ins with measuredValue in minutes');
        }
        const withinLimit = dto.measuredValue <= goal.appTimer!.maxDailyMinutes;
        return { result: withinLimit ? 'success' : 'fail', measuredValue: dto.measuredValue, measuredUnit: 'minutes' };
      }
      case 'locator': {
        // Missing the deadline is reported by the device; arriving is proven with coordinates.
        if (dto.result === 'fail') return { result: 'fail' };
        if (dto.source !== 'location' || dto.latitude === undefined || dto.longitude === undefined) {
          throw new BadRequestException('Locator goals take location check-ins with latitude and longitude');
        }
        const { latitude, longitude, radiusM } = goal.location!;
        const distance = Math.round(distanceMeters(latitude, longitude, dto.latitude, dto.longitude));
        if (distance > radiusM) {
          throw new UnprocessableEntityException({
            code: 'TOO_FAR',
            message: `You are ${distance} m away; the goal needs you within ${radiusM} m`,
            distance,
            radius: radiusM,
          });
        }
        return { result: 'success', measuredValue: distance, measuredUnit: 'meters' };
      }
      case 'ai':
        // A day that ended without a proof is reported by the device; passing needs a proof.
        if (dto.source === 'manual' && dto.result === 'fail') return { result: 'fail' };
        throw new BadRequestException('AI goals are checked through proofs: POST /goals/:id/proofs');
    }
  }

  private scheduledDay(goal: Goal, requested?: string): string {
    const day = requested ?? today();
    // One day of slack: the device's calendar day can be ahead of UTC.
    const latest = isoDate(new Date(Date.now() + 86_400_000));
    if (day < goal.startDate || day > goal.endDate || day > latest) {
      throw new BadRequestException(`scheduledFor must fall between ${goal.startDate} and ${goal.endDate}, and not in the future`);
    }
    return day;
  }

  private async applyOutcome(manager: EntityManager, goal: Goal, userId: string, result: CheckinResult) {
    if (result === 'pending') return;
    const params = { title: goal.title };

    if (result === 'success') {
      await this.pets.apply(userId, 'success', manager);
      await this.notifications.push(manager, userId, 'goal_result', 'checkinSuccess', params, { goalId: goal.id, result });
      return;
    }

    await this.pets.apply(userId, 'fail', manager);
    const fails = await manager.countBy(GoalCheckin, { goalId: goal.id, userId, result: 'fail' });
    const left = goal.maxAttempts - fails;
    if (left > 0) {
      await this.notifications.push(manager, userId, 'goal_result', 'checkinFail', { ...params, left }, { goalId: goal.id, result });
      return;
    }
    await this.penalize(manager, goal, userId);
  }

  /** Out of attempts: the participant's stake leaves escrow as a penalty. */
  private async penalize(manager: EntityManager, goal: Goal, userId: string) {
    const loser = goal.participants.find((item) => item.userId === userId);
    const stake = loser?.stakeAmount ?? 0;
    if (!loser || stake <= 0) return;

    const escrowed = goal.escrowState !== 'none';
    // With the on-chain escrow the contract keeps the whole stake locked; nothing is split here.
    const tip = escrowed ? 0 : round6((stake * goal.devTipPercent) / 100);
    const penalty = round6(stake - tip);
    if (!escrowed && penalty > 0) await this.wallet.record(manager, { userId, goalId: goal.id, type: 'penalty', amount: penalty, note: goal.title });
    if (!escrowed && tip > 0) await this.wallet.record(manager, { userId, goalId: goal.id, type: 'donation', amount: tip, note: goal.title });
    loser.stakeAmount = 0;
    await manager.update(GoalParticipant, { goalId: goal.id, userId }, { stakeAmount: 0 });
    await this.notifications.push(
      manager,
      userId,
      'goal_result',
      'goalFailed',
      { title: goal.title, amount: stake, days: goal.extraLockDays },
      { goalId: goal.id, result: 'fail' },
    );

    const rivals = goal.participants.filter((item) => item.status === 'accepted' && item.stakeAmount > 0);
    if (goal.groupMode === 'vs' && penalty > 0 && rivals.length) {
      const share = round6(penalty / rivals.length);
      for (const rival of rivals) {
        await this.wallet.record(manager, { userId: rival.userId, goalId: goal.id, type: 'reward', amount: share, note: goal.title });
        await this.notifications.push(manager, rival.userId, 'goal_result', 'reward', { title: goal.title, amount: share }, { goalId: goal.id });
      }
    }

    // The goal dies with its owner (or its last player); everyone else gets their stake back.
    if (userId === goal.ownerId || !rivals.length) await this.close(manager, goal, 'failed', 'goalCancelled', userId);
  }

  /** Ends a goal, releasing whatever stakes are still in escrow. */
  private async close(
    manager: EntityManager,
    goal: Goal,
    status: 'completed' | 'cancelled' | 'failed',
    copy: 'goalCompleted' | 'goalCancelled',
    skipUserId?: string,
  ) {
    await manager.update(Goal, { id: goal.id }, { status, resolvedAt: new Date() });
    for (const participant of goal.participants) {
      if (participant.status !== 'accepted' || participant.stakeAmount <= 0 || participant.userId === skipUserId) continue;
      const amount = participant.stakeAmount;
      await manager.update(GoalParticipant, { goalId: goal.id, userId: participant.userId }, { stakeAmount: 0 });
      participant.stakeAmount = 0;
      // The contract returns an escrowed stake; the settlement records it and notifies.
      if (goal.escrowState !== 'none') continue;
      await this.wallet.record(manager, { userId: participant.userId, goalId: goal.id, type: 'stake_release', amount, note: goal.title });
      await this.notifications.push(manager, participant.userId, 'goal_result', copy, { title: goal.title, amount }, { goalId: goal.id });
    }
  }

  /** Goals past their end date are completed lazily, the next time a participant looks. */
  private async settleExpired(userId: string) {
    await this.completeExpired(userId);
  }

  /** Same as above for every user: the settlement sweeper does not wait for anyone to look. */
  async settleExpiredAll() {
    await this.completeExpired();
  }

  private async completeExpired(userId?: string) {
    // The contract's clock decides when an escrowed goal is over.
    const chainNow = this.chain.enabled ? await this.chain.blockTimestamp().catch(() => Math.floor(Date.now() / 1000)) : 0;
    await this.dataSource.transaction(async (manager) => {
      const query = manager
        .createQueryBuilder(Goal, 'g')
        .where("g.status IN ('active', 'paused')")
        // Half a day of slack so no time zone sees its last day cut short. A goal that holds
        // a stake on the chain ends when the contract says so.
        .andWhere(
          `((g.escrow_state = 'none' AND g.end_date < (now() - interval '12 hours')::date)
            OR (g.escrow_state = 'active' AND g.escrow_end_at <= to_timestamp(:chainNow)))`,
          { chainNow },
        )
        .setLock('pessimistic_write', undefined, ['g'])
        .setOnLocked('skip_locked');
      if (userId) query.innerJoin(GoalParticipant, 'p', 'p.goal_id = g.id AND p.user_id = :userId', { userId });
      const expired = await query.getMany();
      for (const { id } of expired) {
        const goal = await manager.findOneOrFail(Goal, { where: { id }, relations: GOAL_RELATIONS });
        await this.close(manager, goal, 'completed', 'goalCompleted');
      }
    });
  }

  private async assertFriends(manager: EntityManager, userId: string, others: string[]) {
    const unique = [...new Set(others)];
    if (!unique.length) return;
    const links = await manager.find(Friendship, {
      where: [
        { requesterId: userId, addresseeId: In(unique), status: 'accepted' },
        { addresseeId: userId, requesterId: In(unique), status: 'accepted' },
      ],
    });
    if (links.length !== unique.length) {
      throw new BadRequestException({ code: 'NOT_FRIENDS', message: 'Every invited user must be an accepted friend' });
    }
  }

  /** Loads a goal the user takes part in (404 otherwise, so ids do not leak). */
  private async load(manager: EntityManager, userId: string, goalId: string): Promise<Goal> {
    const goal = await manager.findOne(Goal, { where: { id: goalId }, relations: GOAL_RELATIONS });
    const participant = goal?.participants.find((item) => item.userId === userId);
    if (!goal || !participant || participant.status === 'declined' || participant.status === 'left') {
      throw new NotFoundException('Goal not found');
    }
    return goal;
  }

  private async loadOwned(manager: EntityManager, userId: string, goalId: string): Promise<Goal> {
    const goal = await this.load(manager, userId, goalId);
    if (goal.ownerId !== userId) throw new ForbiddenException('Only the owner can change this goal');
    return goal;
  }

  /** Loads a goal for a check: it must be active and the user must have a stake in it. */
  private async loadActive(manager: EntityManager, userId: string, goalId: string): Promise<Goal> {
    // Serialises concurrent checks of the same participant.
    await manager.query('SELECT 1 FROM goal_participants WHERE goal_id = $1 AND user_id = $2 FOR UPDATE', [goalId, userId]);
    const goal = await this.load(manager, userId, goalId);
    const participant = goal.participants.find((item) => item.userId === userId)!;
    if (goal.status !== 'active') {
      throw new ConflictException({ code: 'GOAL_NOT_ACTIVE', message: `Goal is ${goal.status}` });
    }
    if (participant.status !== 'accepted') throw new ForbiddenException('Accept the invitation before checking in');
    return goal;
  }

  private async progress(manager: EntityManager, userId: string, goalIds: string[]): Promise<Map<string, Progress>> {
    if (!goalIds.length) return new Map();
    const rows = await manager.query<
      { goal_id: string; success_count: string; fail_count: string; pending_count: string; last_day: string; last_result: CheckinResult }[]
    >(
      `SELECT p.goal_id, p.success_count, p.fail_count, p.pending_count,
              last.scheduled_for::text AS last_day, last.result AS last_result
         FROM v_goal_progress p
         JOIN LATERAL (SELECT c.scheduled_for, c.result FROM goal_checkins c
                        WHERE c.goal_id = p.goal_id AND c.user_id = p.user_id
                        ORDER BY c.scheduled_for DESC LIMIT 1) last ON true
        WHERE p.user_id = $1 AND p.goal_id = ANY($2)`,
      [userId, goalIds],
    );
    return new Map(
      rows.map((row) => [
        row.goal_id,
        {
          successCount: Number(row.success_count),
          failCount: Number(row.fail_count),
          pendingCount: Number(row.pending_count),
          lastCheckin: { scheduledFor: row.last_day, result: row.last_result },
        },
      ]),
    );
  }

  private view(goal: Goal, userId: string, progress: Progress = NO_PROGRESS) {
    const me = goal.participants.find((item) => item.userId === userId);
    const { alarm, appTimer, location, ai } = goal;
    return {
      id: goal.id,
      ownerId: goal.ownerId,
      kind: goal.kind,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      stakeAmount: goal.stakeAmount,
      currency: goal.currency,
      startDate: goal.startDate,
      endDate: goal.endDate,
      repeatDays: goal.repeatDays,
      notificationsEnabled: goal.notificationsEnabled,
      maxAttempts: goal.maxAttempts,
      extraLockDays: goal.extraLockDays,
      devTipPercent: goal.devTipPercent,
      isGroup: goal.isGroup,
      groupMode: goal.groupMode,
      escrowTxHash: goal.escrowTxHash,
      escrow: {
        state: goal.escrowState,
        contract: goal.escrowContract,
        chainId: goal.escrowChainId,
        goalId: goal.escrowGoalId,
        startAt: goal.escrowStartAt,
        endAt: goal.escrowEndAt,
        unlockAt: goal.escrowUnlockAt,
        createTxHash: goal.escrowTxHash,
        resolveTxHash: goal.escrowResolveTxHash,
        claimTxHash: goal.escrowClaimTxHash,
        error: goal.escrowError,
      },
      resolvedAt: goal.resolvedAt,
      createdAt: goal.createdAt,
      alarm: alarm && {
        targetTime: alarm.targetTime,
        reactionSeconds: alarm.reactionSeconds,
        soundTitle: alarm.soundTitle,
        vibrationEnabled: alarm.vibrationEnabled,
      },
      appTimer: appTimer && {
        appPackage: appTimer.appPackage,
        appName: appTimer.appName,
        maxDailyMinutes: appTimer.maxDailyMinutes,
      },
      location: location && {
        placeLabel: location.placeLabel,
        latitude: location.latitude,
        longitude: location.longitude,
        radiusM: location.radiusM,
        arriveBy: location.arriveBy,
      },
      ai: ai && { prompt: ai.prompt, verifier: ai.verifier, verifierUserId: ai.verifierUserId },
      participants: goal.participants.map((participant) => ({
        userId: participant.userId,
        role: participant.role,
        status: participant.status,
        stakeAmount: participant.stakeAmount,
        user: publicUser(participant.user),
      })),
      me: me ? { role: me.role, status: me.status, stakeAmount: me.stakeAmount } : null,
      progress: { ...progress, attemptsLeft: Math.max(0, goal.maxAttempts - progress.failCount) },
    };
  }

  private proofView(proof: Proof) {
    return {
      id: proof.id,
      goalId: proof.goalId,
      userId: proof.userId,
      checkinId: proof.checkinId,
      mediaUrl: mediaUrl(proof.mediaUrl),
      note: proof.note,
      status: proof.status,
      verifier: proof.verifier,
      reviewerId: proof.reviewerId,
      verdictReason: proof.verdictReason,
      createdAt: proof.createdAt,
      reviewedAt: proof.reviewedAt,
    };
  }
}
