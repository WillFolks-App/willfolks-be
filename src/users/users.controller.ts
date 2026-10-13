import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Brackets, DataSource, Repository } from 'typeorm';

import { UserId } from '../common/auth.js';
import { defined } from '../common/db.js';
import { privateUser, publicUser } from '../common/serialize.js';
import { imageUpload } from '../common/uploads.js';
import { Friendship, THEMES, type ThemeId, User, UserSettings } from '../entities/index.js';

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  displayName?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z0-9_]{3,24}$/, { message: 'username must be 3-24 letters, digits or underscores' })
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  locationLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn(['en', 'es'])
  locale?: 'en' | 'es';

  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  walletAddress?: string;

  /** Set once, at the end of the onboarding flow. */
  @IsOptional()
  @IsBoolean()
  onboardingCompleted?: boolean;
}

class UpdateSettingsDto {
  @IsOptional()
  @IsIn(THEMES)
  theme?: ThemeId;

  @IsOptional()
  @IsBoolean()
  haptics?: boolean;

  @IsOptional()
  @IsBoolean()
  showSeconds?: boolean;

  @IsOptional()
  @IsBoolean()
  reminders?: boolean;

  @IsOptional()
  @IsBoolean()
  vibration?: boolean;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserSettings) private readonly settings: Repository<UserSettings>,
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
  ) {}

  @Get('me')
  async me(@UserId() userId: string) {
    return privateUser(await this.users.findOneByOrFail({ id: userId }));
  }

  @Patch('me')
  async updateMe(@UserId() userId: string, @Body() dto: UpdateMeDto) {
    const user = await this.users.findOneByOrFail({ id: userId });
    if (dto.username && dto.username.toLowerCase() !== user.username?.toLowerCase()) {
      const taken = await this.users.findOneBy({ username: dto.username });
      if (taken) throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'That username is already taken' });
    }
    const { onboardingCompleted, ...fields } = dto;
    Object.assign(user, defined(fields));
    if (onboardingCompleted && !user.onboardingCompletedAt) user.onboardingCompletedAt = new Date();
    await this.users.save(user);
    return privateUser(await this.users.findOneByOrFail({ id: userId }));
  }

  @Post('me/avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('photo', imageUpload('avatars')))
  async uploadAvatar(@UserId() userId: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('A "photo" image file is required');
    await this.users.update({ id: userId }, { avatarUrl: `/uploads/avatars/${file.filename}` });
    return privateUser(await this.users.findOneByOrFail({ id: userId }));
  }

  /** Deletes the account and, by cascade, everything that hangs from it. */
  @Delete('me')
  @HttpCode(204)
  async deleteMe(@UserId() userId: string) {
    await this.users.delete({ id: userId });
  }

  @Get('me/settings')
  getSettings(@UserId() userId: string) {
    return this.ensureSettings(userId);
  }

  @Put('me/settings')
  async updateSettings(@UserId() userId: string, @Body() dto: UpdateSettingsDto) {
    await this.ensureSettings(userId);
    const changes = defined(dto);
    if (Object.keys(changes).length) await this.settings.update({ userId }, changes);
    return this.settings.findOneByOrFail({ userId });
  }

  /** Finds people by username or display name, with how each relates to the caller. */
  @Get('search')
  async search(@UserId() userId: string, @Query('q') q = '') {
    const term = q.trim();
    if (term.length < 2) return [];

    const found = await this.users
      .createQueryBuilder('u')
      .where('u.id <> :userId', { userId })
      .andWhere('u.onboarding_completed_at IS NOT NULL')
      .andWhere(
        new Brackets((where) =>
          where.where('u.username ILIKE :like', { like: `%${escapeLike(term)}%` }).orWhere('u.display_name ILIKE :like'),
        ),
      )
      .orderBy('u.username', 'ASC')
      .limit(20)
      .getMany();
    if (!found.length) return [];

    const links = await this.friendships
      .createQueryBuilder('f')
      .where('(f.requester_id = :userId AND f.addressee_id IN (:...ids))', { userId, ids: found.map((user) => user.id) })
      .orWhere('(f.addressee_id = :userId AND f.requester_id IN (:...ids))')
      .getMany();

    return found.map((user) => {
      const link = links.find((item) => item.requesterId === user.id || item.addresseeId === user.id);
      return {
        ...publicUser(user),
        friendship: link ? { id: link.id, status: link.status, incoming: link.addresseeId === userId } : null,
      };
    });
  }

  private async ensureSettings(userId: string): Promise<UserSettings> {
    const existing = await this.settings.findOneBy({ userId });
    if (existing) return existing;
    await this.dataSource.createQueryBuilder().insert().into(UserSettings).values({ userId }).orIgnore().execute();
    return this.settings.findOneByOrFail({ userId });
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
