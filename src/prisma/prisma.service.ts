import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    super({ adapter });
  }

  async onModuleInit() {
    const target = this.safeDbTarget();
    try {
      await this.$connect();
      this.logger.log(`✅ Database connected (${target})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`❌ Database connection FAILED (${target})`);
      this.logger.error(`   Reason: ${reason}`);
      this.logger.error(
        '   Check: DATABASE_URL in .env, PostgreSQL is running, host/port reachable, password correct.',
      );
      // A backend with no database can't serve requests — fail fast so the
      // error is obvious (PM2 will restart and log this same message).
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** "host:port/db" from DATABASE_URL — password is never included in logs. */
  private safeDbTarget(): string {
    const url = process.env.DATABASE_URL;
    if (!url) return 'DATABASE_URL not set';
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
    } catch {
      return 'unparseable DATABASE_URL';
    }
  }
}
