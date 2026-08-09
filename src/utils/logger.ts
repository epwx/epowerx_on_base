import winston from 'winston';
import { config } from '../config';

const logPrefix = (config.runtime.logFilePrefix || '').trim();
const errorLogFile = logPrefix ? `logs/${logPrefix}-error.log` : 'logs/error.log';
const combinedLogFile = logPrefix ? `logs/${logPrefix}-combined.log` : 'logs/combined.log';
const exceptionsLogFile = logPrefix ? `logs/${logPrefix}-exceptions.log` : 'logs/exceptions.log';
const rejectionsLogFile = logPrefix ? `logs/${logPrefix}-rejections.log` : 'logs/rejections.log';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0 && meta.stack) {
      msg += `\n${meta.stack}`;
    } else if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

export const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  defaultMeta: { service: `${config.exchange.name}-volume-bot` },
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new winston.transports.File({
      filename: errorLogFile,
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: combinedLogFile,
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

logger.exceptions.handle(
  new winston.transports.File({ filename: exceptionsLogFile })
);

logger.rejections.handle(
  new winston.transports.File({ filename: rejectionsLogFile })
);

export default logger;
