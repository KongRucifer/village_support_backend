import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { VillageDataController } from './village-data.controller.js';
import { VillageDataService } from './village-data.service.js';

@Module({
  imports: [AuthModule],
  controllers: [VillageDataController],
  providers: [VillageDataService],
})
export class VillageDataModule {}
