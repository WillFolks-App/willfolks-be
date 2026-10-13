import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';

export const AUTH_PROVIDERS = ['dev', 'google', 'facebook', 'twitter'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const THEMES = ['acid', 'void'] as const;
export type ThemeId = (typeof THEMES)[number];
export const LOCATION_ACCESS = ['none', 'foreground', 'background'] as const;
export type LocationAccess = (typeof LOCATION_ACCESS)[number];
export const FRIENDSHIP_STATUSES = ['pending', 'accepted', 'declined', 'blocked'] as const;
export type FriendshipStatus = (typeof FRIENDSHIP_STATUSES)[number];
export const NOTIFICATION_TYPES = [
  'system',
  'goal_created',
  'goal_invite',
  'goal_result',
  'friend_request',
  'friend_accepted',
  'proof_review',
  'wallet',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type PetMood = 'idle' | 'happy' | 'sad';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'citext' })
  email: string;

  @Column({ type: 'citext', nullable: true })
  username: string | null;

  @Column({ type: 'varchar' })
  displayName: string;

  @Column({ type: 'text', nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'enum', enum: AUTH_PROVIDERS, enumName: 'auth_provider' })
  authProvider: AuthProvider;

  @Column({ type: 'varchar', nullable: true })
  providerSubject: string | null;

  @Column({ type: 'varchar', nullable: true })
  walletAddress: string | null;

  @Column({ type: 'varchar' })
  chain: string;

  @Column({ type: 'varchar', nullable: true })
  locationLabel: string | null;

  @Column({ type: 'varchar' })
  timezone: string;

  @Column({ type: 'varchar' })
  locale: string;

  @Column({ type: 'timestamptz', nullable: true })
  onboardingCompletedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('user_settings')
export class UserSettings {
  @PrimaryColumn('uuid')
  userId: string;

  @Column({ type: 'enum', enum: THEMES, enumName: 'theme_id' })
  theme: ThemeId;

  @Column({ type: 'boolean' })
  haptics: boolean;

  @Column({ type: 'boolean' })
  showSeconds: boolean;

  @Column({ type: 'boolean' })
  reminders: boolean;

  @Column({ type: 'boolean' })
  vibration: boolean;
}

@Entity('devices')
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'varchar' })
  installId: string;

  @Column({ type: 'enum', enum: ['android', 'ios', 'web'], enumName: 'device_platform' })
  platform: 'android' | 'ios' | 'web';

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  @Column({ type: 'varchar', nullable: true })
  osVersion: string | null;

  @Column({ type: 'varchar', nullable: true })
  appVersion: string | null;

  @Column({ type: 'boolean' })
  notificationsGranted: boolean;

  @Column({ type: 'boolean' })
  exactAlarmGranted: boolean;

  @Column({ type: 'boolean' })
  usageAccessGranted: boolean;

  @Column({ type: 'boolean' })
  cameraGranted: boolean;

  @Column({ type: 'enum', enum: LOCATION_ACCESS, enumName: 'location_access' })
  locationAccess: LocationAccess;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;
}

@Entity('friendships')
export class Friendship {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  requesterId: string;

  @Column('uuid')
  addresseeId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'requester_id' })
  requester: Relation<User>;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'addressee_id' })
  addressee: Relation<User>;

  @Column({ type: 'enum', enum: FRIENDSHIP_STATUSES, enumName: 'friendship_status' })
  status: FriendshipStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column({ type: 'enum', enum: NOTIFICATION_TYPES, enumName: 'notification_type' })
  type: NotificationType;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'jsonb' })
  data: Record<string, string | number | boolean | null>;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

@Entity('pets')
export class Pet {
  @PrimaryColumn('uuid')
  userId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'enum', enum: ['idle', 'happy', 'sad'], enumName: 'pet_mood' })
  mood: PetMood;

  @Column({ type: 'smallint' })
  energy: number;

  @Column({ type: 'int' })
  streak: number;

  @Column({ type: 'int' })
  bestStreak: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastFedAt: Date | null;
}
