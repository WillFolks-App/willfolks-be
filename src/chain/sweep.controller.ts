import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';

import { Public } from '../common/auth.js';
import { env } from '../env.js';
import { ChainSweeper } from './chain.sweeper.js';

/**
 * One settlement pass on demand. In serverless there is no process to keep the sweeper's timer
 * alive, so a scheduler (Vercel Cron, or any `curl` on a timer) calls this instead.
 */
@ApiExcludeController()
@Controller('internal')
export class SweepController {
  constructor(private readonly sweeper: ChainSweeper) {}

  @Public()
  @Get('sweep')
  async sweep(@Headers('authorization') authorization = '') {
    const expected = Buffer.from(`Bearer ${env.cronSecret}`);
    const received = Buffer.from(authorization);
    if (!env.cronSecret || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new UnauthorizedException();
    }
    await this.sweeper.pass();
    return { ok: true };
  }
}
