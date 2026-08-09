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
  const exchangeName = config.exchange.name.toUpperCase();

  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info(`║   ${exchangeName.padEnd(45, ' ')}║`);
  logger.info('║   VOLUME GENERATION BOT                              ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');
  logger.info(`[BUILD MARKER] ${BUILD_MARKER}`);
  logger.info(`[RUNTIME GIT SHA] ${RUNTIME_GIT_SHA}`);

  if (config.exchange.name === 'azbit' && config.azbitExchange.shadowMode) {
    if (!config.azbitExchange.readOnly) {
      throw new Error('AZBIT_SHADOW_MODE=true requires AZBIT_READ_ONLY=true');
    }
    logger.warn('AZBIT_SHADOW_MODE=true. Strategy decisions will run, but all exchange writes are simulated in memory.');
  } else if (config.exchange.name === 'azbit' && config.azbitExchange.readOnly) {
    logger.warn('AZBIT_READ_ONLY=true. Trading loop is disabled; process will remain online for health monitoring.');
    logger.info('Run read-only diagnostics with npm run test:connection, then set AZBIT_READ_ONLY=false to trade.');

    const shutdownReadOnly = () => {
      logger.info('Received shutdown signal in read-only mode.');
      process.exit(0);
    };

    process.on('SIGINT', shutdownReadOnly);
    process.on('SIGTERM', shutdownReadOnly);
    setInterval(() => undefined, 60_000);
    return;
  }

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
