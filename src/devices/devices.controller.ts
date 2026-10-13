import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';

import { UserId } from '../common/auth.js';
import { defined } from '../common/db.js';
import { Device, LOCATION_ACCESS, type LocationAccess } from '../entities/index.js';

class UpsertDeviceDto {
  @IsString()
  @Length(8, 64)
  installId: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: 'android' | 'ios' | 'web';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  osVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;

  @IsOptional()
  @IsBoolean()
  notificationsGranted?: boolean;

  @IsOptional()
  @IsBoolean()
  exactAlarmGranted?: boolean;

  @IsOptional()
  @IsBoolean()
  usageAccessGranted?: boolean;

  @IsOptional()
  @IsBoolean()
  cameraGranted?: boolean;

  @IsOptional()
  @IsIn(LOCATION_ACCESS)
  locationAccess?: LocationAccess;
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  list(@UserId() userId: string) {
    return this.dataSource.manager.find(Device, { where: { userId }, order: { lastSeenAt: 'DESC' } });
  }

  /** Registers this install and the native permissions it currently holds. */
  @Put()
  async upsert(@UserId() userId: string, @Body() dto: UpsertDeviceDto) {
    const { manager } = this.dataSource;
    const device =
      (await manager.findOneBy(Device, { userId, installId: dto.installId })) ?? manager.create(Device, { userId });
    Object.assign(device, defined(dto), { lastSeenAt: new Date() });
    await manager.save(device);
    return manager.findOneByOrFail(Device, { userId, installId: dto.installId });
  }
}
