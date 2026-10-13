import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { Between, DataSource } from 'typeorm';

import { UserId } from '../common/auth.js';
import { AppUsageSample } from '../entities/index.js';

class UsageSampleDto {
  @IsString()
  @Length(1, 160)
  appPackage: string;

  @IsString()
  @Length(1, 80)
  appName: string;

  @IsDateString({ strict: true })
  @Length(10, 10)
  usageDate: string;

  @IsInt()
  @Min(0)
  @Max(1440)
  foregroundMinutes: number;
}

class PutUsageDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UsageSampleDto)
  samples: UsageSampleDto[];
}

class UsageQueryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

@ApiTags('usage')
@ApiBearerAuth()
@Controller('usage')
export class UsageController {
  constructor(private readonly dataSource: DataSource) {}

  /** Daily foreground minutes per app, as read from Android's UsageStatsManager. */
  @Put()
  async put(@UserId() userId: string, @Body() dto: PutUsageDto) {
    if (dto.samples.length) {
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(AppUsageSample)
        .values(dto.samples.map((sample) => ({ ...sample, userId })))
        .orUpdate(['app_name', 'foreground_minutes', 'updated_at'], ['user_id', 'app_package', 'usage_date'])
        .execute();
    }
    return { saved: dto.samples.length };
  }

  @Get()
  list(@UserId() userId: string, @Query() query: UsageQueryDto) {
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(Date.parse(to) - 6 * 86_400_000));
    return this.dataSource.manager.find(AppUsageSample, {
      where: { userId, usageDate: Between(from, to) },
      order: { usageDate: 'DESC', foregroundMinutes: 'DESC' },
    });
  }
}
