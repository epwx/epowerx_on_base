import { ethers } from 'ethers';
import axios from 'axios';
/**
 * Fetches the price of WETH in USDT from CoinGecko.
 * @returns Price of 1 WETH in USDT
 */
import { logger } from './logger';


let cachedWethUsdt: number | undefined = undefined;
let cacheTimestamp: number | undefined = undefined;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const FALLBACK_WETH_USDT = 2200; // fallback value if all requests fail

export async function fetchWethUsdtPrice(): Promise<number> {
  const now = Date.now();
  if (cachedWethUsdt !== undefined && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION_MS)) {
    logger.debug(`fetchWethUsdtPrice: Returning cached value ${cachedWethUsdt} USDT`);
    return cachedWethUsdt;
  } else if (cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION_MS)) {
    logger.warn(`⚠️ fetchWethUsdtPrice: Cached value is undefined, using fallback value ${FALLBACK_WETH_USDT} USDT`);
    return FALLBACK_WETH_USDT;
  }
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usdt';
  try {
    const response = await axios.get(url);
    if (!response.data || !response.data.ethereum || typeof response.data.ethereum.usdt !== 'number') {
      logger.error('❌ fetchWethUsdtPrice: Unexpected response from CoinGecko', { data: response.data });
      throw new Error('Invalid CoinGecko response');
    }
    cachedWethUsdt = response.data.ethereum.usdt;
    cacheTimestamp = now;
    logger.info(`✅ fetchWethUsdtPrice: 1 WETH = ${cachedWethUsdt} USDT (fresh)`);
    return cachedWethUsdt;
  } catch (error) {
    logger.error('❌ fetchWethUsdtPrice: Failed to fetch WETH/USDT price from CoinGecko', { error });
    if (cachedWethUsdt !== undefined) {
      logger.warn(`⚠️ fetchWethUsdtPrice: Using last cached value ${cachedWethUsdt} USDT due to error`);
      return cachedWethUsdt;
    }
    logger.warn(`⚠️ fetchWethUsdtPrice: Using static fallback value ${FALLBACK_WETH_USDT} USDT due to error`);
    return FALLBACK_WETH_USDT;
  }
}

// Uniswap V2 Pair ABI (minimal, only for getReserves and token addresses)
const UNISWAP_V2_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)'
];

/**
 * Fetches the price of EPWX in WETH from the Uniswap V2 pool.
 * @param providerUrl Ethereum RPC URL
 * @param pairAddress Uniswap V2 pair address (EPWX/WETH)
 * @param epwxAddress EPWX token address
 * @returns Price of 1 EPWX in WETH
 */
export async function fetchEpwXPriceFromUniswap(
  providerUrl: string,
  pairAddress: string,
  epwxAddress: string
): Promise<number> {
  const provider = new ethers.providers.JsonRpcProvider(providerUrl);
  const pair = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);

  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  const token1 = await pair.token1();

  // Determine which reserve is EPWX and which is WETH
  let epwxReserve, wethReserve;
  if (token0.toLowerCase() === epwxAddress.toLowerCase()) {
    epwxReserve = reserve0;
    wethReserve = reserve1;
  } else {
    epwxReserve = reserve1;
    wethReserve = reserve0;
  }

  // Price = WETH reserve / EPWX reserve
  return Number(wethReserve) / Number(epwxReserve);
}
