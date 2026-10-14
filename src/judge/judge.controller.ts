import { Body, Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, IsUrl, MaxLength } from 'class-validator';

import { Public } from '../common/auth.js';
import { JudgeService, type Verdict } from './judge.service.js';

class VerifyDto {
  @IsString()
  @MaxLength(160)
  title: string;

  @IsString()
  @MaxLength(1000)
  prompt: string;

  @IsUrl({ require_tld: false })
  photoUrl: string;
}

/**
 * Paid by x402, not by session: `JudgeModule` mounts the paywall in front of this route, so a
 * request only gets here once its USDC payment settled. It is public for the JWT guard.
 */
@ApiTags('judge')
@Controller('judge')
export class JudgeController {
  constructor(private readonly judge: JudgeService) {}

  @Public()
  @Post('verify')
  @HttpCode(200)
  verify(@Body() dto: VerifyDto): Promise<Verdict> {
    if (!this.judge.enabled) throw new NotFoundException('The AI judge is not enabled');
    return this.judge.decide(dto);
  }
}
