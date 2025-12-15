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
  const epwxWethPair = new ethers.Contract(epwxWethPairAddress, UNISWAP_V2_PAIR_ABI, provider);
  const [reserve0, reserve1] = await epwxWethPair.getReserves();
  const token0 = await epwxWethPair.token0();
  const token1 = await epwxWethPair.token1();
  const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
  const [decimals0, decimals1] = await Promise.all([
    token0Contract.decimals(),
    token1Contract.decimals()
  ]);
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

  // Fetch ETH/USD price from CoinGecko
  let ethPriceUSD = 0;
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    ethPriceUSD = response.data?.ethereum?.usd || 0;
    if (!ethPriceUSD) throw new Error('Invalid ETH/USD from CoinGecko');
  } catch (error) {
    logger.error('Failed to fetch ETH/USD from CoinGecko', { error });
    throw error;
  }

  // Final price: EPWX in USD
  const epwxPriceInUsd = epwxPriceInWeth * ethPriceUSD;
  return epwxPriceInUsd;
}
// ...existing code...
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

// Minimal ERC20 ABI for decimals
const ERC20_ABI = [
  'function decimals() view returns (uint8)'
];

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
