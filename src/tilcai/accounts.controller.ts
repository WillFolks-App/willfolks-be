import { BadRequestException, Body, Controller, Get, HttpStatus, HttpException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { TilcaiError, passkeyOwner } from 'tilcai-sdk';

import { UserId } from '../common/auth.js';
import { ChainService } from '../chain/chain.service.js';
import { TilcaiService } from './tilcai.service.js';

class CreateAccountDto {
  /** Uncompressed P-256 public key of the passkey: `0x04` + x + y. Public material only. */
  @Matches(/^0x04[0-9a-fA-F]{128}$/)
  publicKey: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  credentialId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(253)
  rpId: string;
}

/**
 * The user's smart account (SCA) on Monad, issued by TilcAI. The owner is a P-256 passkey that
 * stays on the phone: the backend sends TilcAI its public key and TilcAI derives the address,
 * pays the deployment and is never a signer. TilcAI keeps the registry (by `externalRef` = user id),
 * so the backend stores nothing.
 */
@ApiTags('chain')
@ApiBearerAuth()
@Controller('chain/account')
export class AccountsController {
  constructor(
    private readonly tilcai: TilcaiService,
    private readonly chain: ChainService,
  ) {}

  @Get()
  async get(@UserId() userId: string) {
    if (!this.tilcai.accountsEnabled) return { enabled: false as const, account: null };
    const [account] = await this.tilcai.accounts.accounts.list({ externalRef: userId, network: 'monad', limit: 1 }).catch(this.fail);
    if (!account) return { enabled: true as const, account: null };
    const usdc = this.chain.enabled && account.state === 'ACTIVE' ? await this.chain.usdcBalance(account.address).catch(() => null) : null;
    return { enabled: true as const, account: { address: account.address, state: account.state, deployTx: account.deployTxHash, usdc } };
  }

  /** Issues the account (or returns the one that exists: the address is fixed by the key and the user). */
  @Post()
  async create(@UserId() userId: string, @Body() dto: CreateAccountDto) {
    if (!this.tilcai.accountsEnabled) throw new BadRequestException({ code: 'TILCAI_DISABLED', message: 'Smart accounts are not enabled' });
    const api = this.tilcai.accounts;
    try {
      const created = await api.accounts.create({
        network: 'monad',
        externalRef: userId,
        owner: passkeyOwner({ publicKey: dto.publicKey, credentialId: dto.credentialId, rpId: dto.rpId }),
        idempotencyKey: `wf-sca-${userId}`,
      });
      const ready = await api.accounts.waitForActive(created.account.id, { timeoutMs: 90_000, intervalMs: 2_000 });
      return {
        address: ready.account.address,
        state: ready.account.state,
        deployTx: ready.account.deployTxHash,
        replayed: created.replayed,
        explorer: ready.links.address,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  private fail = (error: unknown): never => {
    if (error instanceof HttpException) throw error;
    if (error instanceof TilcaiError) {
      throw new HttpException({ code: `TILCAI_${error.code}`, message: error.message }, error.status >= 400 && error.status < 500 ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_GATEWAY);
    }
    throw error;
  };
}
