import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

import { UserId } from '../common/auth.js';
import { PetService } from './pet.service.js';

const PET_ACTIONS = ['feed', 'play', 'poke', 'rest'] as const;

class PetActionDto {
  @IsIn(PET_ACTIONS)
  action: (typeof PET_ACTIONS)[number];
}

class RenamePetDto {
  @IsString()
  @Length(1, 24)
  name: string;
}

@ApiTags('pet')
@ApiBearerAuth()
@Controller('pet')
export class PetController {
  constructor(private readonly pets: PetService) {}

  @Get()
  get(@UserId() userId: string) {
    return this.pets.get(userId);
  }

  @Patch()
  rename(@UserId() userId: string, @Body() dto: RenamePetDto) {
    return this.pets.rename(userId, dto.name);
  }

  @Post('actions')
  @HttpCode(200)
  act(@UserId() userId: string, @Body() dto: PetActionDto) {
    return dto.action === 'rest' ? this.pets.rest(userId) : this.pets.apply(userId, dto.action);
  }
}
