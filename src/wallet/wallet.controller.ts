import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { UserId } from '../common/auth.js';
import { QrPurchaseService } from './qr-purchase.service.js';
import { WalletService } from './wallet.service.js';

class DepositDto {
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.01)
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

class QrPurchaseDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10000)
  usdc: number;
}

class QrConfirmDto {
  @IsString()
  @MaxLength(1000)
  ticket: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly qr: QrPurchaseService,
  ) {}

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

  /** Terms of buying USDC with a Bolivian bank QR: rate, limits, validity. */
  @Get('qr-purchases/config')
  qrConfig() {
    return this.qr.config();
  }

  /** Issues the bank QR (through TilcAI) for `usdc` at the current rate. */
  @Post('qr-purchases')
  qrPurchase(@UserId() userId: string, @Body() dto: QrPurchaseDto) {
    return this.qr.create(userId, dto.usdc);
  }

  /** Pending until the bank pays the QR; then the USDC is sent and the deposit recorded, once. */
  @Post('qr-purchases/confirm')
  qrConfirm(@UserId() userId: string, @Body() dto: QrConfirmDto) {
    return this.qr.confirm(userId, dto.ticket);
  }

  @Post('withdrawals')
  withdraw(@UserId() userId: string, @Body() dto: WithdrawDto) {
    return this.wallet.withdraw(userId, dto.amount, dto.note);
  }
}
