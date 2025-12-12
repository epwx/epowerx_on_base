import { logger } from './logger';
import { config } from '../config';

export interface OrderGuardOptions {
  freeUSDT: number;
  totalOrdersToPlace: number;
  reservedForActiveOrdersUSD?: number;
  feeBufferUSD?: number;
  minFreeUSD?: number;
  orderSizePercent?: number;
  maxOrderUSDCap?: number;
}

export interface OrderGuardResult {
  allowed: boolean;
  perOrderUSD: number;
  usableUSD: number;
  reason?: string;
}

/**
 * Computes a safe USD amount to use per new order given available balance and constraints.
 * This prevents placing orders larger than available funds.
 * 
 * @param options Configuration options for order size calculation
 * @returns Result indicating if orders are allowed and the safe per-order size
 */
export function computeSafeOrderSizeUSD(options: OrderGuardOptions): OrderGuardResult {
  const {
    freeUSDT,
    totalOrdersToPlace,
    reservedForActiveOrdersUSD = 0,
    feeBufferUSD = 0.5,
    minFreeUSD = 1.0,
    orderSizePercent = 0.8, // Use 80% of usable funds by default
    maxOrderUSDCap = 10,
  } = options;

  logger.debug('Order guard input:', {
    freeUSDT,
    totalOrdersToPlace,
    reservedForActiveOrdersUSD,
    feeBufferUSD,
    minFreeUSD,
    orderSizePercent,
    maxOrderUSDCap,
  });

  // Check minimum free balance requirement
  if (freeUSDT <= minFreeUSD) {
    logger.warn(`Order guard: insufficient free USDT ($${freeUSDT.toFixed(2)} <= $${minFreeUSD.toFixed(2)})`);
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD: 0,
      reason: 'insufficient_free',
    };
  }

  // Calculate usable balance after reservations
  const usableUSD = Math.max(0, freeUSDT - feeBufferUSD - reservedForActiveOrdersUSD);

  logger.debug(`Usable USD: $${usableUSD.toFixed(2)} (free: $${freeUSDT.toFixed(2)}, buffer: $${feeBufferUSD.toFixed(2)}, reserved: $${reservedForActiveOrdersUSD.toFixed(2)})`);

  if (usableUSD <= 0) {
    logger.warn(`Order guard: no usable funds after reservations (usable: $${usableUSD.toFixed(2)})`);
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD: 0,
      reason: 'insufficient_after_reservations',
    };
  }

  // Calculate per-order size with configured constraints
  const perOrderUSD = Math.min(
    maxOrderUSDCap,
    (usableUSD * orderSizePercent) / Math.max(1, totalOrdersToPlace)
  );

  logger.debug(`Calculated per-order USD: $${perOrderUSD.toFixed(2)} (before min order size check)`);

  // Enforce minimum order size from config
  const minOrderSize = config.volumeStrategy.minOrderSize;
  if (perOrderUSD < minOrderSize) {
    logger.warn(`Order guard: per-order size ($${perOrderUSD.toFixed(2)}) below minimum ($${minOrderSize.toFixed(2)})`);
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD,
      reason: 'below_min_order_size',
    };
  }

  logger.debug(`Order guard: allowed, per-order=$${perOrderUSD.toFixed(2)}, usable=$${usableUSD.toFixed(2)}`);

  return {
    allowed: true,
    perOrderUSD,
    usableUSD,
  };
}
