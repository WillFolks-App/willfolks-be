import { Body, Controller, ForbiddenException, HttpCode, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';

import { Public } from '../common/auth.js';
import { privateUser } from '../common/serialize.js';
import { Pet, User, UserSettings } from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';

class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  displayName?: string;

  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  walletAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn(['en', 'es'])
  locale?: 'en' | 'es';
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Development login: signs in (or signs up) with just an email, standing in for the
   * OAuth provider. Disabled unless AUTH_DEV_LOGIN=true.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    if (!env.devLogin) throw new ForbiddenException('Development login is disabled');

    const { user, isNew } = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOneBy(User, { email: dto.email });
      if (existing) {
        // The device wallet is the account wallet: a reinstall brings a new one.
        // With the on-chain escrow a wallet is linked only by signing (POST /chain/wallet).
        if (!env.chain.enabled && dto.walletAddress && dto.walletAddress !== existing.walletAddress) {
          existing.walletAddress = dto.walletAddress;
          await manager.save(existing);
        }
        return { user: existing, isNew: false };
      }

      const { identifiers } = await manager.insert(User, {
        email: dto.email,
        displayName: dto.displayName ?? dto.email.split('@')[0].slice(0, 60),
        authProvider: 'dev',
        providerSubject: dto.email.toLowerCase(),
        walletAddress: env.chain.enabled ? null : (dto.walletAddress ?? null),
        timezone: dto.timezone,
        locale: dto.locale,
      });
      const id = identifiers[0].id as string;
      await manager.insert(UserSettings, { userId: id });
      await manager.insert(Pet, { userId: id });
      await this.notifications.push(manager, id, 'system', 'welcome');
      return { user: await manager.findOneByOrFail(User, { id }), isNew: true };
    });

    return {
      accessToken: await this.jwt.signAsync({ sub: user.id }),
      isNew,
      user: privateUser(user),
    };
  }
}
