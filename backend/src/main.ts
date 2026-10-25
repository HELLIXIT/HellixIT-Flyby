import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const origins = (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim());
  app.enableCors({ origin: origins.includes('*') ? true : origins });
  app.enableShutdownHooks();

  // When run together with the web app (scripts/run.mjs) the API gets API_PORT on localhost
  // and the web app owns PORT. Standalone, it falls back to PORT on all interfaces.
  const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
  const host = process.env.API_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  Logger.log(`Flyby API listening on ${host}:${port}`, 'Bootstrap');
}

process.on('unhandledRejection', (err) => Logger.error(`Unhandled rejection: ${String(err)}`, 'Process'));
void bootstrap();
