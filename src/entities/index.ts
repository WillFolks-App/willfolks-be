import {
  AppUsageSample,
  Goal,
  GoalAiSettings,
  GoalAlarmSettings,
  GoalAppTimerSettings,
  GoalCheckin,
  GoalLocationSettings,
  GoalParticipant,
  Proof,
} from './goal.entities.js';
import { Device, Friendship, Notification, Pet, User, UserSettings } from './user.entities.js';
import { WalletTransaction } from './wallet.entities.js';

export * from './goal.entities.js';
export * from './user.entities.js';
export * from './wallet.entities.js';

export const ENTITIES = [
  User,
  UserSettings,
  Device,
  Friendship,
  Notification,
  Pet,
  Goal,
  GoalAlarmSettings,
  GoalAppTimerSettings,
  GoalLocationSettings,
  GoalAiSettings,
  GoalParticipant,
  GoalCheckin,
  Proof,
  AppUsageSample,
  WalletTransaction,
];
