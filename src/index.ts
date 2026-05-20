import { VolumeGenerationStrategy } from './strategies/volume-generation.strategy';
import { logger } from './utils/logger';
import { config } from './config';
import { execSync } from 'child_process';
import path from 'path';

function resolveRuntimeGitSha(): string {
  if (process.env.RUNTIME_GIT_SHA) {
    return process.env.RUNTIME_GIT_SHA;
  }

  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

const RUNTIME_GIT_SHA = resolveRuntimeGitSha();
const BUILD_MARKER = RUNTIME_GIT_SHA === 'unknown'
  ? 'build-unknown-marker'
  : `build-${RUNTIME_GIT_SHA}-marker`;

async function main() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║   BICONOMY EXCHANGE VOLUME GENERATION BOT           ║');
  logger.info('║   Zero-Fee Market Maker Account                      ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');
  logger.info(`[BUILD MARKER] ${BUILD_MARKER}`);
  logger.info(`[RUNTIME GIT SHA] ${RUNTIME_GIT_SHA}`);

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
