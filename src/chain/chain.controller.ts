import { BadRequestException, Body, ConflictException, Controller, Get, HttpException, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { DataSource, MoreThan } from 'typeorm';

import { Public, UserId } from '../common/auth.js';
import { User, WalletTransaction } from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { ChainService } from './chain.service.js';

class LinkWalletDto {
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  address: string;

  @IsString()
  @Matches(/^0x[0-9a-fA-F]{130}$/)
  signature: string;
}

const FAUCET_NOTE = 'Testnet faucet';
const FAUCET_COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_HOURS ?? 24) * 3_600_000;

@ApiTags('chain')
@Controller('chain')
export class ChainController {
  constructor(
    private readonly chain: ChainService,
    private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Network, contract and token the app needs to sign transactions. Public. */
  @Public()
  @Get('config')
  config() {
    return this.chain.config();
  }

  /** The user's wallet: its link, on-chain balances and the message to sign to link it. */
  @ApiBearerAuth()
  @Get('wallet')
  async wallet_(@UserId() userId: string) {
    const user = await this.dataSource.manager.findOneByOrFail(User, { id: userId });
    const base = { linkMessage: this.chain.linkMessage(userId), address: user.walletAddress, enabled: env.chain.enabled };
    if (!env.chain.enabled || !user.walletAddress) return { ...base, usdc: 0, native: '0' };
    const [usdc, native] = await Promise.all([this.chain.usdcBalance(user.walletAddress), this.chain.nativeBalance(user.walletAddress)]);
    return { ...base, usdc, native: native.toString() };
  }

  /** Links a wallet to the account after proving the user holds its key. */
  @ApiBearerAuth()
  @Post('wallet')
  async link(@UserId() userId: string, @Body() dto: LinkWalletDto) {
    const address = await this.chain.verifyWalletOwnership(userId, dto.address, dto.signature);
    const taken = await this.dataSource.query<{ id: string }[]>(
      'SELECT id FROM users WHERE lower(wallet_address) = lower($1) AND id <> $2',
      [address, userId],
    );
    if (taken.length) throw new ConflictException({ code: 'WALLET_TAKEN', message: 'That wallet belongs to another account' });
    await this.dataSource.manager.update(User, { id: userId }, { walletAddress: address, chain: env.chain.name });
    return { address };
  }

  /** Testnet only: USDC and gas from the treasury, once per cooldown. */
  @ApiBearerAuth()
  @Post('faucet')
  async faucet(@UserId() userId: string) {
    const user = await this.dataSource.manager.findOneByOrFail(User, { id: userId });
    if (!user.walletAddress) throw new BadRequestException({ code: 'WALLET_REQUIRED', message: 'Link a wallet first' });

    const since = new Date(Date.now() - FAUCET_COOLDOWN_MS);
    const last = FAUCET_COOLDOWN_MS > 0
      ? await this.dataSource.manager.findOne(WalletTransaction, {
          where: { userId, type: 'deposit', note: FAUCET_NOTE, createdAt: MoreThan(since) },
          order: { createdAt: 'DESC' },
        })
      : null;
    if (last) {
      throw new HttpException(
        { code: 'FAUCET_COOLDOWN', message: 'The faucet already sent you funds today', retryAt: new Date(last.createdAt.getTime() + FAUCET_COOLDOWN_MS) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { usdcTx, gasTx } = await this.chain.faucet(user.walletAddress);
    await this.dataSource.transaction(async (manager) => {
      const tx = await this.wallet.record(manager, {
        userId,
        type: 'deposit',
        amount: env.chain.faucetUsdc,
        method: 'crypto',
        txHash: usdcTx,
        note: FAUCET_NOTE,
      });
      await this.notifications.push(manager, userId, 'wallet', 'faucet', { amount: env.chain.faucetUsdc }, { transactionId: tx.id });
    });
    return {
      usdc: env.chain.faucetUsdc,
      usdcTx,
      gasTx,
      balance: await this.chain.usdcBalance(user.walletAddress),
      explorer: this.chain.explorerTx(usdcTx),
    };
  }
}
