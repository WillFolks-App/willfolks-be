import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth/auth.controller.js';
import { ChainSettlementService } from './chain/chain-settlement.service.js';
import { ChainController } from './chain/chain.controller.js';
import { ChainService } from './chain/chain.service.js';
import { ChainSweeper } from './chain/chain.sweeper.js';
import { JwtAuthGuard } from './common/auth.js';
import { SnakeNamingStrategy } from './common/db.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { DevicesController } from './devices/devices.controller.js';
import { ENTITIES } from './entities/index.js';
import { env } from './env.js';
import { FriendsController } from './friends/friends.controller.js';
import { GoalsController, ProofsController } from './goals/goals.controller.js';
import { GoalsService } from './goals/goals.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PetController } from './pet/pet.controller.js';
import { PetService } from './pet/pet.service.js';
import { UsageController } from './usage/usage.controller.js';
import { UsersController } from './users/users.controller.js';
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
  ],
  providers: [
    GoalsService,
    WalletService,
    ChainService,
    ChainSettlementService,
    ChainSweeper,
    NotificationsService,
    PetService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
