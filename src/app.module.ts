import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth/auth.controller.js';
import { ChainSettlementService } from './chain/chain-settlement.service.js';
import { ChainController } from './chain/chain.controller.js';
import { ChainService } from './chain/chain.service.js';
import { ChainSweeper } from './chain/chain.sweeper.js';
import { SweepController } from './chain/sweep.controller.js';
import { JwtAuthGuard } from './common/auth.js';
import { SnakeNamingStrategy } from './common/db.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { DevicesController } from './devices/devices.controller.js';
import { ENTITIES } from './entities/index.js';
import { env } from './env.js';
import { FriendsController } from './friends/friends.controller.js';
import { JudgeController } from './judge/judge.controller.js';
import { JudgeService } from './judge/judge.service.js';
import { AccountsController } from './tilcai/accounts.controller.js';
import { TilcaiController } from './tilcai/tilcai.controller.js';
import { TilcaiService } from './tilcai/tilcai.service.js';
import { GoalsController, ProofsController } from './goals/goals.controller.js';
import { GoalsService } from './goals/goals.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PetController } from './pet/pet.controller.js';
import { PetService } from './pet/pet.service.js';
import { UsageController } from './usage/usage.controller.js';
import { UsersController } from './users/users.controller.js';
import { QrPurchaseService } from './wallet/qr-purchase.service.js';
import { WalletController } from './wallet/wallet.controller.js';
import { WalletService } from './wallet/wallet.service.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: env.databaseUrl,
      entities: ENTITIES,
      namingStrategy: new SnakeNamingStrategy(),
      // The schema lives in willfolks-database/sql; the API never alters it.
      synchronize: false,
      extra: { max: env.databasePoolMax },
    }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.register({ secret: env.jwtSecret, signOptions: { expiresIn: '30d' } }),
  ],
  controllers: [
    AuthController,
    UsersController,
    FriendsController,
    GoalsController,
    ProofsController,
    WalletController,
    NotificationsController,
    PetController,
    UsageController,
    DevicesController,
    DashboardController,
    ChainController,
    SweepController,
    AccountsController,
    TilcaiController,
    JudgeController,
  ],
  providers: [
    GoalsService,
    WalletService,
    QrPurchaseService,
    ChainService,
    ChainSettlementService,
    ChainSweeper,
    NotificationsService,
    PetService,
    TilcaiService,
    JudgeService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  constructor(private readonly judge: JudgeService) {}

  /** The AI judge sells its verdicts over x402: the paywall runs before the controller. */
  configure(consumer: MiddlewareConsumer): void {
    if (!this.judge.enabled) return;
    consumer.apply(this.judge.paywall.express()).forRoutes('judge/verify');
  }
}
