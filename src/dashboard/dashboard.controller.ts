import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { Public, UserId } from '../common/auth.js';
import type { GoalKind } from '../entities/index.js';
import { GoalsService } from '../goals/goals.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PetService } from '../pet/pet.service.js';
import { WalletService } from '../wallet/wallet.service.js';

interface FeedRow {
  id: string;
  goal_id: string | null;
  kind: GoalKind | null;
  title: string | null;
  tone: 'won' | 'lost' | 'staked' | 'neutral';
  amount: string;
  value: string | null;
  occurred_at: Date;
}

/** Latest things that happened to the user's goals: verdicts and stake movements. */
const FEED_SQL = `
  SELECT c.id, c.goal_id, g.kind, g.title,
         CASE c.result WHEN 'success' THEN 'won' WHEN 'fail' THEN 'lost' ELSE 'neutral' END AS tone,
         0::numeric AS amount,
         CASE WHEN c.measured_value IS NULL THEN NULL
              ELSE trim(to_char(c.measured_value, 'FM999990.##'), '.') || ' ' || COALESCE(c.measured_unit, '') END AS value,
         c.occurred_at
    FROM goal_checkins c JOIN goals g ON g.id = c.goal_id
   WHERE c.user_id = $1
  UNION ALL
  SELECT t.id, t.goal_id, g.kind, COALESCE(g.title, t.note),
         CASE t.type WHEN 'stake_lock' THEN 'staked' WHEN 'penalty' THEN 'lost' ELSE 'won' END,
         t.amount, NULL, t.created_at
    FROM wallet_transactions t LEFT JOIN goals g ON g.id = t.goal_id
   WHERE t.user_id = $1 AND t.type IN ('stake_lock', 'penalty', 'reward', 'stake_release')
   ORDER BY occurred_at DESC
   LIMIT 20`;

@ApiTags('dashboard')
@Controller()
export class DashboardController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly goals: GoalsService,
    private readonly wallet: WalletService,
    private readonly pets: PetService,
    private readonly notifications: NotificationsService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    await this.dataSource.query('SELECT 1');
    return { status: 'ok', database: 'up', time: new Date().toISOString() };
  }

  /** Everything the home screen and the widget need, in one round trip. */
  @ApiBearerAuth()
  @Get('dashboard')
  async dashboard(@UserId() userId: string) {
    // Listing first settles expired goals, so the balance below is already final.
    const goals = await this.goals.list(userId);
    const [balance, pet, unreadNotifications, feed] = await Promise.all([
      this.wallet.balance(userId),
      this.pets.get(userId),
      this.notifications.unreadCount(userId),
      this.dataSource.query<FeedRow[]>(FEED_SQL, [userId]),
    ]);
    return {
      balance,
      pet,
      unreadNotifications,
      activeGoals: goals.filter((goal) => goal.status === 'active' && goal.me?.status === 'accepted').length,
      feed: feed.map((row) => ({
        id: row.id,
        goalId: row.goal_id,
        kind: row.kind,
        title: row.title,
        tone: row.tone,
        amount: Number(row.amount),
        value: row.value?.trim() || null,
        occurredAt: row.occurred_at,
      })),
    };
  }
}
