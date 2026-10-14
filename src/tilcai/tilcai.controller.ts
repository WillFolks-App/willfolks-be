import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../common/auth.js';
import { TilcaiService } from './tilcai.service.js';

@ApiTags('tilcai')
@Controller('tilcai')
export class TilcaiController {
  constructor(private readonly tilcai: TilcaiService) {}

  /** Which TilcAI capabilities this deployment uses, and whether TilcAI answers. No secrets. */
  @Public()
  @Get('status')
  status() {
    return this.tilcai.status();
  }
}
