/**
 * Fetches the price of EPWX in USD using PancakeSwap EPWX/WETH pair and CoinGecko ETH/USD price.
 * @param providerUrl Ethereum RPC URL (Base)
 * @param epwxWethPairAddress PancakeSwap V2 pair address for EPWX/WETH
 * @param epwxAddress EPWX token address
 * @returns Price of 1 EPWX in USD
 */

import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import axios from 'axios';
import { logger } from './logger';

async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000, label = ''): Promise<T> {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn(`Retry ${i + 1}/${retries} failed${label ? ' for ' + label : ''}:`, { error: err });
      if (i < retries - 1) await new Promise(res => setTimeout(res, delay * (i + 1)));
    }
  }
  throw lastErr;
}

const UNISWAP_V2_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)'
];
const ERC20_ABI = [
  'function decimals() external view returns (uint8)'
];

// Cache for ETH/USD price to avoid hammering CoinGecko API
const ETH_PRICE_CACHE = {
  price: 2200, // Default fallback
  timestamp: 0,
  cacheTTL: 60000 // Cache for 60 seconds
};

async function getCachedEthPrice(): Promise<number> {
  const now = Date.now();
  const cacheStale = now - ETH_PRICE_CACHE.timestamp > ETH_PRICE_CACHE.cacheTTL;
  
  if (!cacheStale) {
    logger.debug(`💾 Using cached ETH/USD price: $${ETH_PRICE_CACHE.price} (cache age: ${now - ETH_PRICE_CACHE.timestamp}ms)`);
    return ETH_PRICE_CACHE.price;
  }

  // Cache is stale, fetch fresh price
  let ethPriceUSD = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
        timeout: 5000
      });
      ethPriceUSD = response.data?.ethereum?.usd || 0;
      if (ethPriceUSD) {
        logger.debug(`✅ Fetched fresh ETH/USD price from CoinGecko: $${ethPriceUSD}`);
        ETH_PRICE_CACHE.price = ethPriceUSD;
        ETH_PRICE_CACHE.timestamp = now;
        return ethPriceUSD;
      }
    } catch (error) {
      logger.warn(`CoinGecko ETH/USD fetch failed (attempt ${i + 1}/3)`, { error });
      if (i < 2) await new Promise(res => setTimeout(res, 2000 * (i + 1)));
    }
  }

  // All retries failed, use cached price
  logger.warn(`⚠️  Failed to fetch ETH/USD from CoinGecko, using cached fallback: $${ETH_PRICE_CACHE.price}`);
  ETH_PRICE_CACHE.timestamp = now; // Reset cache timer to avoid constant retry attempts
  return ETH_PRICE_CACHE.price;
}

export async function fetchEpwXPriceFromPancake(
  providerUrl: string,
  epwxWethPairAddress: string,
  epwxAddress: string
): Promise<number> {
  const provider = new JsonRpcProvider(providerUrl);
  let reserve0: bigint, reserve1: bigint, token0: string, token1: string, decimals0: number, decimals1: number;
  try {
    const reserves: [bigint, bigint, number] = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).getReserves();
    }, 3, 1500, 'getReserves');
    reserve0 = reserves[0];
    reserve1 = reserves[1];
    token0 = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token0();
    }, 3, 1000, 'token0');
    token1 = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token1();
    }, 3, 1000, 'token1');
    decimals0 = await retry(() => {
      return new Contract(token0, ERC20_ABI, provider).decimals();
    }, 3, 1000, 'decimals0');
    decimals1 = await retry(() => {
      return new Contract(token1, ERC20_ABI, provider).decimals();
    }, 3, 1000, 'decimals1');
  } catch (err) {
    logger.error('❌ Failed to fetch on-chain reserves or token info for PancakeSwap pair', { error: err });
    // Return -1 to indicate error
    return -1;
  }
  let epwxReserve: bigint, wethReserve: bigint, epwxDecimals: number, wethDecimals: number;
  if (token0.toLowerCase() === epwxAddress.toLowerCase()) {
    epwxReserve = reserve0;
    wethReserve = reserve1;
    epwxDecimals = decimals0;
    wethDecimals = decimals1;
  } else {
    epwxReserve = reserve1;
    wethReserve = reserve0;
    epwxDecimals = decimals1;
    wethDecimals = decimals0;
  }
  const epwxReserveNorm = Number(formatUnits(epwxReserve, epwxDecimals));
  const wethReserveNorm = Number(formatUnits(wethReserve, wethDecimals));
  const epwxPriceInWeth = wethReserveNorm / epwxReserveNorm;

  // Fetch ETH/USD price from cache (which handles CoinGecko fetch with 60s TTL)
  const ethPriceUSD = await getCachedEthPrice();

  // Final price: EPWX in USD
  const epwxPriceInUsd = epwxPriceInWeth * ethPriceUSD;
  return epwxPriceInUsd;
}

export async function fetchEpwXPriceFromUniswap(
  providerUrl: string,
  pairAddress: string,
  epwxAddress: string
): Promise<number> {
  const provider = new JsonRpcProvider(providerUrl);
  const pair = new Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);

  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  const token1 = await pair.token1();

  // Get decimals for both tokens
  const token0Contract = new Contract(token0, ERC20_ABI, provider);
  const token1Contract = new Contract(token1, ERC20_ABI, provider);
  const [decimals0, decimals1] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals()
  ]);

  // Determine which reserve is EPWX and which is WETH
  let epwxReserve: bigint, wethReserve: bigint, epwxDecimals: number, wethDecimals: number;
  if (token0.toLowerCase() === epwxAddress.toLowerCase()) {
    epwxReserve = reserve0;
    wethReserve = reserve1;
    epwxDecimals = decimals0;
    wethDecimals = decimals1;
  } else {
    epwxReserve = reserve1;
    wethReserve = reserve0;
    epwxDecimals = decimals1;
    wethDecimals = decimals0;
  }

  // Adjust reserves to decimals for both tokens
  const epwxReserveNorm = Number(formatUnits(epwxReserve, epwxDecimals));
  const wethReserveNorm = Number(formatUnits(wethReserve, wethDecimals));

  // Price = WETH reserve / EPWX reserve (in WETH per EPWX)
  const priceInWeth = wethReserveNorm / epwxReserveNorm;
  return priceInWeth;
}

/**
 * Fetches EPWX price in WETH (without USD conversion) for fast price tracking
 * This is used by the price tracking loop to avoid CoinGecko API calls
 * @param providerUrl Ethereum RPC URL (Base)
 * @param epwxWethPairAddress PancakeSwap V2 pair address for EPWX/WETH
 * @param epwxAddress EPWX token address
 * @returns Price of 1 EPWX in WETH (no USD conversion)
 */
export async function fetchEpwXPriceInWethOnly(
  providerUrl: string,
  epwxWethPairAddress: string,
  epwxAddress: string
): Promise<number> {
  const provider = new JsonRpcProvider(providerUrl);
  try {
    const reserves: [bigint, bigint, number] = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).getReserves();
    }, 2, 500, 'getReserves for price tracking');
    
    const reserve0 = reserves[0];
    const reserve1 = reserves[1];
    
    const token0 = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token0();
    }, 2, 300, 'token0 for price tracking');

    const token1 = await retry(() => {
      return new Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token1();
    }, 2, 300, 'token1 for price tracking');
    
    const decimals0 = await retry(() => {
      return new Contract(token0, ERC20_ABI, provider).decimals();
    }, 2, 300, 'decimals0 for price tracking');

    const decimals1 = await retry(() => {
      return new Contract(token1, ERC20_ABI, provider).decimals();
    }, 2, 300, 'decimals1 for price tracking');
    
    let epwxReserve: bigint, wethReserve: bigint, epwxDecimals: number, wethDecimals: number;
    if (token0.toLowerCase() === epwxAddress.toLowerCase()) {
      epwxReserve = reserve0;
      wethReserve = reserve1;
      epwxDecimals = decimals0;
      wethDecimals = decimals1;
    } else {
      epwxReserve = reserve1;
      wethReserve = reserve0;
      epwxDecimals = decimals1;
      wethDecimals = decimals0;
    }
    
    const epwxReserveNorm = Number(formatUnits(epwxReserve, epwxDecimals));
    const wethReserveNorm = Number(formatUnits(wethReserve, wethDecimals));
    const epwxPriceInWeth = wethReserveNorm / epwxReserveNorm;
    
    return epwxPriceInWeth;
  } catch (error) {
    logger.error('❌ Failed to fetch EPWX/WETH price for tracking:', error);
    return -1;
  }
}
