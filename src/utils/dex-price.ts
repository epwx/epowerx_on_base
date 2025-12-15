/**
 * Fetches the price of EPWX in USD using PancakeSwap EPWX/WETH pair and CoinGecko ETH/USD price.
 * @param providerUrl Ethereum RPC URL (Base)
 * @param epwxWethPairAddress PancakeSwap V2 pair address for EPWX/WETH
 * @param epwxAddress EPWX token address
 * @returns Price of 1 EPWX in USD
 */

import { ethers } from 'ethers';
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

export async function fetchEpwXPriceFromPancake(
  providerUrl: string,
  epwxWethPairAddress: string,
  epwxAddress: string
): Promise<number> {
  const provider = new ethers.providers.JsonRpcProvider(providerUrl);
  let reserve0, reserve1, token0, token1, decimals0, decimals1;
  try {
    [reserve0, reserve1] = await retry(() => {
      return new ethers.Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).getReserves();
    }, 3, 1500, 'getReserves');
    token0 = await retry(() => {
      return new ethers.Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token0();
    }, 3, 1000, 'token0');
    token1 = await retry(() => {
      return new ethers.Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider).token1();
    }, 3, 1000, 'token1');
    decimals0 = await retry(() => {
      return new ethers.Contract(token0, ERC20_ABI, provider).decimals();
    }, 3, 1000, 'decimals0');
    decimals1 = await retry(() => {
      return new ethers.Contract(token1, ERC20_ABI, provider).decimals();
    }, 3, 1000, 'decimals1');
  } catch (err) {
    logger.error('❌ Failed to fetch on-chain reserves or token info for PancakeSwap pair', { error: err });
    // Return -1 to indicate error
    return -1;
  }
  let epwxReserve, wethReserve, epwxDecimals, wethDecimals;
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
  const epwxReserveNorm = Number(epwxReserve) / Math.pow(10, epwxDecimals);
  const wethReserveNorm = Number(wethReserve) / Math.pow(10, wethDecimals);
  const epwxPriceInWeth = wethReserveNorm / epwxReserveNorm;

  // Fetch ETH/USD price from CoinGecko with retry and fallback
  let ethPriceUSD = 0;
  let coingeckoError = null;
  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
      ethPriceUSD = response.data?.ethereum?.usd || 0;
      if (ethPriceUSD) break;
    } catch (error) {
      coingeckoError = error;
      logger.warn(`CoinGecko ETH/USD fetch failed (attempt ${i + 1}/3)`, { error });
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  if (!ethPriceUSD) {
    logger.error('Failed to fetch ETH/USD from CoinGecko after retries, using static fallback value 2200');
    ethPriceUSD = 2200; // Fallback static value
  }

  // Final price: EPWX in USD
  const epwxPriceInUsd = epwxPriceInWeth * ethPriceUSD;
  return epwxPriceInUsd;
}

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

  // Get decimals for both tokens
  const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
  const [decimals0, decimals1] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals()
  ]);

  // Determine which reserve is EPWX and which is WETH
  let epwxReserve, wethReserve, epwxDecimals, wethDecimals;
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

  // Adjust reserves to 18 decimals for both tokens
  const epwxReserveNorm = Number(epwxReserve) / Math.pow(10, epwxDecimals);
  const wethReserveNorm = Number(wethReserve) / Math.pow(10, wethDecimals);

  // Price = WETH reserve / EPWX reserve (in WETH per EPWX)
  const priceInWeth = wethReserveNorm / epwxReserveNorm;
  return priceInWeth;
}
