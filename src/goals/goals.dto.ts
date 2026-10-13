import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  CHECKIN_SOURCES,
  type CheckinSource,
  GOAL_KINDS,
  GOAL_VERIFIERS,
  type GoalKind,
  type GoalVerifier,
  GROUP_MODES,
  type GroupMode,
} from '../entities/index.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class AlarmSettingsDto {
  @Matches(HHMM, { message: 'targetTime must be HH:MM' })
  targetTime: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(900)
  reactionSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  soundTitle?: string;

  @IsOptional()
  @IsBoolean()
  vibrationEnabled?: boolean;
}

export class AppTimerSettingsDto {
  @IsString()
  @Length(1, 160)
  appPackage: string;

  @IsString()
  @Length(1, 80)
  appName: string;

  @IsInt()
  @Min(1)
  @Max(1440)
  maxDailyMinutes: number;
}

export class LocationSettingsDto {
  @IsString()
  @Length(1, 120)
  placeLabel: string;

  @IsLatitude()
  latitude: number;

  @IsLongitude()
  longitude: number;

  @IsOptional()
  @IsInt()
  @Min(25)
  @Max(5000)
  radiusM?: number;

  @Matches(HHMM, { message: 'arriveBy must be HH:MM' })
  arriveBy: string;
}

export class AiSettingsDto {
  @IsString()
  @Length(3, 1000)
  prompt: string;

  @IsOptional()
  @IsIn(GOAL_VERIFIERS)
  verifier?: GoalVerifier;

  /** Required when `verifier` is `friend`: the accepted friend who will judge the proofs. */
  @IsOptional()
  @IsUUID()
  verifierUserId?: string;
}

export class CreateGoalDto {
  @IsIn(GOAL_KINDS)
  kind: GoalKind;

  @IsString()
  @Length(1, 80)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(1)
  @Max(10000)
  stakeAmount: number;

  @IsOptional()
  @IsDateString({ strict: true })
  @Length(10, 10)
  startDate?: string;

  @IsDateString({ strict: true })
  @Length(10, 10)
  endDate: string;

  /** Week days the goal applies to: 0 = Sunday … 6 = Saturday. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  repeatDays?: number[];

  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;

  /** Failed checks tolerated before the stake is lost. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  extraLockDays?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  devTipPercent?: number;

  /** Friends to invite. Their presence makes the goal a group goal. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  participantIds?: string[];

  @IsOptional()
  @IsIn(GROUP_MODES)
  groupMode?: GroupMode;

  @IsOptional()
  @ValidateNested()
  @Type(() => AlarmSettingsDto)
  alarm?: AlarmSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppTimerSettingsDto)
  appTimer?: AppTimerSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationSettingsDto)
  location?: LocationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiSettingsDto)
  ai?: AiSettingsDto;
}

export class UpdateGoalDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Pausing stops the checks; the stake stays in escrow. */
  @IsOptional()
  @IsIn(['active', 'paused'])
  status?: 'active' | 'paused';

  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  repeatDays?: number[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AlarmSettingsDto)
  alarm?: AlarmSettingsDto;
}

export class RespondInviteDto {
  @IsBoolean()
  accept: boolean;
}

export class CreateCheckinDto {
  @IsIn(CHECKIN_SOURCES.filter((source) => source !== 'proof'))
  source: Exclude<CheckinSource, 'proof'>;

  /**
   * Alarm and manual checks report their own result. Usage and location checks are
   * judged by the server from `measuredValue` / the coordinates.
   */
  @IsOptional()
  @IsIn(['success', 'fail'])
  result?: 'success' | 'fail';

  /** Local calendar day the check belongs to. Defaults to today (UTC). */
  @IsOptional()
  @IsDateString({ strict: true })
  @Length(10, 10)
  scheduledFor?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  measuredValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  measuredUnit?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

export class CreateProofDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Length(10, 10)
  scheduledFor?: string;
}

export class ReviewProofDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
