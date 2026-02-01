import { Module } from '@nestjs/common';
import { PromptQueueService } from './prompt-queue.service';
import { PromptQueueController } from './prompt-queue.controller';
import { QueueSchedulerService } from './queue-scheduler.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [PromptQueueService, QueueSchedulerService],
  controllers: [PromptQueueController],
  exports: [PromptQueueService, QueueSchedulerService],
})
export class PromptQueueModule {}
