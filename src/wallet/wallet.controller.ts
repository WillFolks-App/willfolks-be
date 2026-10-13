import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { UserId } from '../common/auth.js';
import { WalletService } from './wallet.service.js';

class DepositDto {
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(1)
  @Max(10000)
  amount: number;

  @IsIn(['crypto', 'fiat'])
  method: 'crypto' | 'fiat';
}

class WithdrawDto {
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(1)
  @Max(10000)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  balance(@UserId() userId: string) {
    return this.wallet.balance(userId);
  }

  @Get('transactions')
  list(@UserId() userId: string, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    return this.wallet.list(userId, Math.min(Math.max(limit, 1), 200));
  }

  /** A single movement, shown in the app as its voucher. */
  @Get('transactions/:id')
  get(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.get(userId, id);
  }

  /** Simulated: the deposit is confirmed at once, no chain or payment processor involved. */
  @Post('deposits')
  deposit(@UserId() userId: string, @Body() dto: DepositDto) {
    return this.wallet.deposit(userId, dto.amount, dto.method);
  }

  @Post('withdrawals')
  withdraw(@UserId() userId: string, @Body() dto: WithdrawDto) {
    return this.wallet.withdraw(userId, dto.amount, dto.note);
  }
}
