import { VolumeGenerationStrategy } from './strategies/volume-generation.strategy';
import { logger } from './utils/logger';
import { config } from './config';

const BUILD_MARKER = 'build-e38bfba-marker';

async function main() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║   BICONOMY EXCHANGE VOLUME GENERATION BOT           ║');
  logger.info('║   Zero-Fee Market Maker Account                      ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');
  logger.info(`[BUILD MARKER] ${BUILD_MARKER}`);

  const strategy = new VolumeGenerationStrategy();
  let isShuttingDown = false;

  // Handle graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info('Received shutdown signal...');
    await strategy.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    shutdown();
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    shutdown();
  });

  try {
    await strategy.start();
  } catch (error) {
    logger.error('Fatal error starting bot:', error);
    process.exit(1);
  }
}

main();
