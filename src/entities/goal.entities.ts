import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';

import { hhmm, numeric } from '../common/db.js';
import { User } from './user.entities.js';

export const GOAL_KINDS = ['alarm', 'app_timer', 'locator', 'ai'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GOAL_STATUSES = ['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GROUP_MODES = ['coop', 'vs'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];
export const GOAL_VERIFIERS = ['ai', 'friend'] as const;
export type GoalVerifier = (typeof GOAL_VERIFIERS)[number];
export type ParticipantRole = 'owner' | 'participant' | 'judge';
export type ParticipantStatus = 'invited' | 'accepted' | 'declined' | 'left';
export const CHECKIN_RESULTS = ['pending', 'success', 'fail'] as const;
export type CheckinResult = (typeof CHECKIN_RESULTS)[number];
export const CHECKIN_SOURCES = ['alarm', 'usage', 'location', 'proof', 'manual'] as const;
export type CheckinSource = (typeof CHECKIN_SOURCES)[number];
export type ProofStatus = 'pending' | 'approved' | 'rejected';
export const ESCROW_STATES = ['none', 'pending', 'active', 'succeeded', 'failed_locked', 'claimed', 'expired', 'cancelled'] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

@Entity('goals')
export class Goal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  ownerId: string;

  @Column({ type: 'enum', enum: GOAL_KINDS, enumName: 'goal_kind' })
  kind: GoalKind;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: GOAL_STATUSES, enumName: 'goal_status' })
  status: GoalStatus;

  @Column({ type: 'numeric', transformer: numeric })
  stakeAmount: number;

  @Column({ type: 'varchar' })
  currency: string;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'smallint', array: true })
  repeatDays: number[];

  @Column({ type: 'boolean' })
  notificationsEnabled: boolean;

  @Column({ type: 'smallint' })
  maxAttempts: number;

  @Column({ type: 'smallint' })
  extraLockDays: number;

  @Column({ type: 'numeric', transformer: numeric })
  devTipPercent: number;

  @Column({ type: 'boolean' })
  isGroup: boolean;

  @Column({ type: 'enum', enum: GROUP_MODES, enumName: 'group_mode', nullable: true })
  groupMode: GroupMode | null;

  @Column({ type: 'varchar', nullable: true })
  escrowTxHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'enum', enum: ESCROW_STATES, enumName: 'escrow_state' })
  escrowState: EscrowState;

  @Column({ type: 'varchar', nullable: true })
  escrowContract: string | null;

  @Column({ type: 'integer', nullable: true })
  escrowChainId: number | null;

  /** bigint column: node-postgres returns it as a string. */
  @Column({ type: 'bigint', nullable: true })
  escrowGoalId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  escrowStartAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  escrowEndAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  escrowUnlockAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  escrowMetadataHash: string | null;

  @Column({ type: 'varchar', nullable: true })
  escrowResolveTxHash: string | null;

  @Column({ type: 'varchar', nullable: true })
  escrowClaimTxHash: string | null;

  @Column({ type: 'jsonb', nullable: true })
  escrowEvidence: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  escrowError: string | null;

  @Column({ type: 'smallint' })
  escrowAttempts: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => GoalAlarmSettings, (settings) => settings.goal)
  alarm: Relation<GoalAlarmSettings> | null;

  @OneToOne(() => GoalAppTimerSettings, (settings) => settings.goal)
  appTimer: Relation<GoalAppTimerSettings> | null;

  @OneToOne(() => GoalLocationSettings, (settings) => settings.goal)
  location: Relation<GoalLocationSettings> | null;

  @OneToOne(() => GoalAiSettings, (settings) => settings.goal)
  ai: Relation<GoalAiSettings> | null;

  @OneToMany(() => GoalParticipant, (participant) => participant.goal)
  participants: Relation<GoalParticipant>[];
}

@Entity('goal_alarm_settings')
export class GoalAlarmSettings {
  @PrimaryColumn('uuid')
  goalId: string;

  @OneToOne(() => Goal, (goal) => goal.alarm)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @Column({ type: 'time', transformer: hhmm })
  targetTime: string;

  @Column({ type: 'smallint' })
  reactionSeconds: number;

  @Column({ type: 'varchar', nullable: true })
  soundTitle: string | null;

  @Column({ type: 'text', nullable: true })
  soundUri: string | null;

  @Column({ type: 'boolean' })
  vibrationEnabled: boolean;
}

@Entity('goal_app_timer_settings')
export class GoalAppTimerSettings {
  @PrimaryColumn('uuid')
  goalId: string;

  @OneToOne(() => Goal, (goal) => goal.appTimer)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @Column({ type: 'varchar' })
  appPackage: string;

  @Column({ type: 'varchar' })
  appName: string;

  @Column({ type: 'smallint' })
  maxDailyMinutes: number;
}

@Entity('goal_location_settings')
export class GoalLocationSettings {
  @PrimaryColumn('uuid')
  goalId: string;

  @OneToOne(() => Goal, (goal) => goal.location)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @Column({ type: 'varchar' })
  placeLabel: string;

  @Column({ type: 'double precision' })
  latitude: number;

  @Column({ type: 'double precision' })
  longitude: number;

  @Column({ type: 'int' })
  radiusM: number;

  @Column({ type: 'time', transformer: hhmm })
  arriveBy: string;
}

@Entity('goal_ai_settings')
export class GoalAiSettings {
  @PrimaryColumn('uuid')
  goalId: string;

  @OneToOne(() => Goal, (goal) => goal.ai)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ type: 'enum', enum: GOAL_VERIFIERS, enumName: 'goal_verifier' })
  verifier: GoalVerifier;

  @Column({ type: 'uuid', nullable: true })
  verifierUserId: string | null;
}

@Entity('goal_participants')
export class GoalParticipant {
  @PrimaryColumn('uuid')
  goalId: string;

  @PrimaryColumn('uuid')
  userId: string;

  @ManyToOne(() => Goal, (goal) => goal.participants)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ type: 'enum', enum: ['owner', 'participant', 'judge'], enumName: 'participant_role' })
  role: ParticipantRole;

  @Column({ type: 'enum', enum: ['invited', 'accepted', 'declined', 'left'], enumName: 'participant_status' })
  status: ParticipantStatus;

  @Column({ type: 'numeric', transformer: numeric })
  stakeAmount: number;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}

@Entity('goal_checkins')
export class GoalCheckin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  goalId: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'date' })
  scheduledFor: string;

  @Column({ type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'enum', enum: CHECKIN_RESULTS, enumName: 'checkin_result' })
  result: CheckinResult;

  @Column({ type: 'enum', enum: CHECKIN_SOURCES, enumName: 'checkin_source' })
  source: CheckinSource;

  @Column({ type: 'numeric', transformer: numeric, nullable: true })
  measuredValue: number | null;

  @Column({ type: 'varchar', nullable: true })
  measuredUnit: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude: number | null;

  @Column({ type: 'jsonb' })
  details: Record<string, unknown>;
}

@Entity('proofs')
export class Proof {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  goalId: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => Goal)
  @JoinColumn({ name: 'goal_id' })
  goal: Relation<Goal>;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ type: 'uuid', nullable: true })
  checkinId: string | null;

  @Column({ type: 'text' })
  mediaUrl: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'enum', enum: ['pending', 'approved', 'rejected'], enumName: 'proof_status' })
  status: ProofStatus;

  @Column({ type: 'enum', enum: GOAL_VERIFIERS, enumName: 'goal_verifier' })
  verifier: GoalVerifier;

  @Column({ type: 'uuid', nullable: true })
  reviewerId: string | null;

  @Column({ type: 'text', nullable: true })
  verdictReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}

@Entity('app_usage_samples')
export class AppUsageSample {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'varchar' })
  appPackage: string;

  @Column({ type: 'varchar' })
  appName: string;

  @Column({ type: 'date' })
  usageDate: string;

  @Column({ type: 'int' })
  foregroundMinutes: number;
}
