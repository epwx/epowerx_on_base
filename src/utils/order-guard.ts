/**
 * Order Guard Utility
 * 
 * Ensures the volume generation bot only places orders within available balance limits.
 * Prevents insufficient funds errors by calculating safe order sizes after accounting for:
 * - Fee buffers
 * - Reserved funds from active orders
 * - Minimum balance requirements
 */

export interface OrderGuardConfig {
  feeBufferUSD?: number;        // Reserve for fees (default: 0.5)
  minFreeUSD?: number;           // Minimum free balance required (default: 1.0)
  orderSizePercent?: number;     // Percentage of usable funds to use (default: 0.8 = 80%)
  maxOrderUSDCap?: number;       // Maximum USD per single order (default: 10)
  minOrderSize?: number;         // Minimum order size from config (optional)
}

export interface OrderGuardResult {
  allowed: boolean;
  perOrderUSD: number;
  usableUSD: number;
  reason?: string;
}

export interface ComputeSafeOrderSizeOptions {
  freeUSDT: number;                    // Available USDT free balance
  totalOrdersToPlace: number;          // How many new orders will be placed
  reservedForActiveOrdersUSD?: number; // Amount locked in existing active orders
  config?: OrderGuardConfig;           // Configuration overrides
}

/**
 * Computes a safe USD amount to use per new order given current balance constraints.
 * 
 * @param options - Configuration options for the order guard
 * @returns OrderGuardResult with allowed status, per-order size, and usable balance
 */
export function computeSafeOrderSizeUSD(options: ComputeSafeOrderSizeOptions): OrderGuardResult {
  const {
    freeUSDT,
    totalOrdersToPlace,
    reservedForActiveOrdersUSD = 0,
    config = {},
  } = options;

  // Default configuration values
  const feeBufferUSD = config.feeBufferUSD ?? 0.5;
  const minFreeUSD = config.minFreeUSD ?? 1.0;
  const orderSizePercent = config.orderSizePercent ?? 0.8;
  const maxOrderUSDCap = config.maxOrderUSDCap ?? 10;
  const minOrderSize = config.minOrderSize;

  // Calculate usable balance: free balance minus buffers and reservations
  const usableUSD = Math.max(0, freeUSDT - feeBufferUSD - reservedForActiveOrdersUSD);

  // Check if we have sufficient free balance to proceed
  if (freeUSDT <= minFreeUSD) {
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD,
      reason: 'insufficient_free',
    };
  }

  // Calculate per-order size: divide usable funds among orders, respecting limits
  const ordersCount = Math.max(1, totalOrdersToPlace);
  const perOrderUSD = Math.min(
    maxOrderUSDCap,
    (usableUSD * orderSizePercent) / ordersCount
  );

  // Enforce minimum order size if configured
  if (minOrderSize !== undefined && perOrderUSD < minOrderSize) {
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD,
      reason: 'below_min_order_size',
    };
  }

  // Guard against zero or negative order sizes
  if (perOrderUSD <= 0) {
    return {
      allowed: false,
      perOrderUSD: 0,
      usableUSD,
      reason: 'insufficient_usable_balance',
    };
  }

  return {
    allowed: true,
    perOrderUSD,
    usableUSD,
  };
}
