import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import { UserId } from '../common/auth.js';
import { publicUser } from '../common/serialize.js';
import { Friendship, User } from '../entities/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';

class RequestFriendDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  username?: string;
}

class RespondFriendDto {
  @IsIn(['accepted', 'declined'])
  status: 'accepted' | 'declined';
}

@ApiTags('friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendsController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** Accepted friends plus the requests still waiting, in either direction. */
  @Get()
  async list(@UserId() userId: string) {
    const links = await this.dataSource.manager.find(Friendship, {
      where: [
        { requesterId: userId, status: 'accepted' },
        { addresseeId: userId, status: 'accepted' },
        { requesterId: userId, status: 'pending' },
        { addresseeId: userId, status: 'pending' },
      ],
      relations: { requester: true, addressee: true },
      order: { createdAt: 'DESC' },
    });
    const view = (link: Friendship) => ({
      id: link.id,
      status: link.status,
      since: link.respondedAt ?? link.createdAt,
      user: publicUser(link.requesterId === userId ? link.addressee : link.requester),
    });
    return {
      friends: links.filter((link) => link.status === 'accepted').map(view),
      incoming: links.filter((link) => link.status === 'pending' && link.addresseeId === userId).map(view),
      outgoing: links.filter((link) => link.status === 'pending' && link.requesterId === userId).map(view),
    };
  }

  @Post()
  async request(@UserId() userId: string, @Body() dto: RequestFriendDto) {
    if (!dto.userId && !dto.username) throw new BadRequestException('userId or username is required');

    return this.dataSource.transaction(async (manager) => {
      const target = await manager.findOneBy(User, dto.userId ? { id: dto.userId } : { username: dto.username });
      if (!target) throw new NotFoundException('User not found');
      if (target.id === userId) throw new BadRequestException('You cannot befriend yourself');

      const existing = await manager.findOne(Friendship, {
        where: [
          { requesterId: userId, addresseeId: target.id },
          { requesterId: target.id, addresseeId: userId },
        ],
      });
      if (existing?.status === 'accepted') throw new ConflictException('You are already friends');
      if (existing?.status === 'blocked') throw new ForbiddenException('This request is not allowed');
      if (existing?.status === 'pending') {
        if (existing.requesterId === userId) throw new ConflictException('Request already sent');
        // They had already asked: asking back is accepting.
        return this.respond(userId, existing.id, { status: 'accepted' });
      }
      // A declined request can be sent again; the pair keeps a single row.
      if (existing) await manager.delete(Friendship, { id: existing.id });

      const me = await manager.findOneByOrFail(User, { id: userId });
      const { identifiers } = await manager.insert(Friendship, { requesterId: userId, addresseeId: target.id });
      await this.notifications.push(manager, target.id, 'friend_request', 'friendRequest', { name: me.displayName }, { userId });
      return { id: identifiers[0].id as string, status: 'pending' as const, user: publicUser(target) };
    });
  }

  @Patch(':id')
  async respond(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RespondFriendDto) {
    return this.dataSource.transaction(async (manager) => {
      const link = await manager.findOne(Friendship, { where: { id }, relations: { requester: true, addressee: true } });
      if (!link || link.addresseeId !== userId) throw new NotFoundException('Friend request not found');
      if (link.status !== 'pending') throw new ConflictException(`Request already ${link.status}`);

      link.status = dto.status;
      link.respondedAt = new Date();
      await manager.save(link);
      if (dto.status === 'accepted') {
        await this.notifications.push(
          manager,
          link.requesterId,
          'friend_accepted',
          'friendAccepted',
          { name: link.addressee.displayName },
          { userId },
        );
      }
      return { id: link.id, status: link.status, user: publicUser(link.requester) };
    });
  }

  /** Removes a friend or withdraws/declines a request. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const link = await this.dataSource.manager.findOneBy(Friendship, { id });
    if (!link || (link.requesterId !== userId && link.addresseeId !== userId)) {
      throw new NotFoundException('Friendship not found');
    }
    await this.dataSource.manager.delete(Friendship, { id });
  }
}
