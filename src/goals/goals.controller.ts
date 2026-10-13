import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';

import { UserId } from '../common/auth.js';
import { imageUpload } from '../common/uploads.js';
import { CreateCheckinDto, CreateGoalDto, CreateProofDto, RespondInviteDto, ReviewProofDto, UpdateGoalDto } from './goals.dto.js';
import { GoalsService } from './goals.service.js';

class EscrowTxDto {
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  txHash: string;
}

@ApiTags('goals')
@ApiBearerAuth()
@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  /** Goals the user owns, joined or was invited to (cancelled ones excluded). */
  @Get()
  list(@UserId() userId: string) {
    return this.goals.list(userId);
  }

  /** Creates the goal and locks the stake; fails with INSUFFICIENT_FUNDS when the balance is short. */
  @Post()
  create(@UserId() userId: string, @Body() dto: CreateGoalDto) {
    return this.goals.create(userId, dto);
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.get(userId, id);
  }

  @Patch(':id')
  update(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGoalDto) {
    return this.goals.update(userId, id, dto);
  }

  /** Cancels the goal and releases the stakes still in escrow. */
  @Delete(':id')
  @HttpCode(204)
  cancel(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.cancel(userId, id);
  }

  @Patch(':id/invitation')
  respondInvite(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RespondInviteDto) {
    return this.goals.respondInvite(userId, id, dto.accept);
  }

  /** On-chain escrow: confirms the transaction that locked the stake (`createGoal`). */
  @Post(':id/escrow')
  @HttpCode(200)
  confirmEscrow(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EscrowTxDto) {
    return this.goals.confirmEscrow(userId, id, dto.txHash);
  }

  /** On-chain escrow: confirms a `cancel` sent to the contract before the goal started. */
  @Post(':id/escrow/cancel')
  @HttpCode(200)
  confirmEscrowCancel(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EscrowTxDto) {
    return this.goals.confirmEscrowCancel(userId, id, dto.txHash);
  }

  @Get(':id/checkins')
  listCheckins(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.listCheckins(userId, id);
  }

  /** One verdict per goal, user and day; repeating the call returns the stored one. */
  @Post(':id/checkins')
  @HttpCode(200)
  checkin(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCheckinDto) {
    return this.goals.checkin(userId, id, dto);
  }

  @Get(':id/proofs')
  listProofs(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.listProofs(userId, id);
  }

  @Post(':id/proofs')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('photo', imageUpload('proofs')))
  submitProof(
    @UserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProofDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('A "photo" image file is required');
    return this.goals.submitProof(userId, id, file, dto);
  }
}

@ApiTags('proofs')
@ApiBearerAuth()
@Controller('proofs')
export class ProofsController {
  constructor(private readonly goals: GoalsService) {}

  /** Proofs of friends waiting for this user's verdict. */
  @Get('reviews')
  pendingReviews(@UserId() userId: string) {
    return this.goals.pendingReviews(userId);
  }

  @Patch(':id')
  review(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewProofDto) {
    return this.goals.reviewProof(userId, id, dto);
  }
}
