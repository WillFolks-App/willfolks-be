import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { env } from '../env.js';
import { GoalsService } from '../goals/goals.service.js';
import { ChainSettlementService } from './chain-settlement.service.js';

/** Periodic pass: completes goals that ran out of time, then settles what is pending on the chain. */
@Injectable()
export class ChainSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ChainSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly goals: GoalsService,
    private readonly settlement: ChainSettlementService,
  ) {}

  onModuleInit(): void {
    if (!env.chain.enabled || env.chain.sweepMs <= 0) return;
    this.timer = setInterval(() => void this.pass(), env.chain.sweepMs);
    this.timer.unref();
    this.log.log(`settlement sweeper every ${env.chain.sweepMs} ms`);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async pass(): Promise<void> {
    try {
      await this.goals.settleExpiredAll();
      await this.settlement.tick();
    } catch (error) {
      this.log.warn(`sweep failed: ${String(error)}`);
    }
  }
}
