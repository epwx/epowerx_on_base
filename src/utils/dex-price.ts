/**
 * Fetches the price of EPWX in USD using EPWX/WETH pair reserves and a configurable ETH/USD source.
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

const CHAINLINK_AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)'
];

type EthUsdSource = 'chainlink' | 'coingecko' | 'static';

interface EthUsdConfig {
  source: EthUsdSource;
  chainlinkFeedAddress?: string;
  fallbackPriceUsd?: number;
  coingeckoUrl?: string;
  cacheMs?: number;
}

let cachedEthUsdPrice: number | null = null;
let cachedEthUsdAt = 0;

async function fetchEthUsdPrice(provider: JsonRpcProvider, cfg: EthUsdConfig): Promise<number> {
  const fallbackPriceUsd = cfg.fallbackPriceUsd ?? 2200;
  const cacheMs = cfg.cacheMs ?? 120000;
  const source = cfg.source;

  if (cachedEthUsdPrice && Date.now() - cachedEthUsdAt <= cacheMs) {
    return cachedEthUsdPrice;
  }

  if (source === 'chainlink') {
    const feedAddress = cfg.chainlinkFeedAddress;
    if (!feedAddress) {
      logger.warn('ETH_USD_SOURCE=chainlink but ETH_USD_CHAINLINK_FEED_ADDRESS is empty; using fallback source path');
    } else {
      try {
        const feed = new Contract(feedAddress, CHAINLINK_AGGREGATOR_ABI, provider);
        const [roundData, decimals] = await Promise.all([
          retry(() => feed.latestRoundData(), 3, 1000, 'chainlink latestRoundData'),
          retry(() => feed.decimals(), 3, 1000, 'chainlink decimals')
        ]);

        const answer = roundData[1] as bigint;
        const precision = Number(decimals);
        const ethUsd = Number(answer) / Math.pow(10, precision);

        if (Number.isFinite(ethUsd) && ethUsd > 0) {
          cachedEthUsdPrice = ethUsd;
          cachedEthUsdAt = Date.now();
          return ethUsd;
        }

        logger.warn('Chainlink ETH/USD returned non-positive or invalid answer; falling back');
      } catch (error) {
        logger.warn('Chainlink ETH/USD fetch failed; falling back', { error });
      }
    }
  }

  if (source === 'coingecko' || source === 'chainlink') {
    const coingeckoUrl = cfg.coingeckoUrl || 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

    for (let i = 0; i < 3; i++) {
      try {
        const response = await axios.get(coingeckoUrl);
        const ethUsd = response.data?.ethereum?.usd || 0;
        if (ethUsd) {
          cachedEthUsdPrice = ethUsd;
          cachedEthUsdAt = Date.now();
          return ethUsd;
        }
      } catch (error) {
        logger.warn(`CoinGecko ETH/USD fetch failed (attempt ${i + 1}/3)`, { error });
        await new Promise(res => setTimeout(res, 1000 * (i + 1)));
      }
    }
  }

  logger.error(`Failed to fetch ETH/USD from configured source (${source}), using static fallback value ${fallbackPriceUsd}`);
  cachedEthUsdPrice = fallbackPriceUsd;
  cachedEthUsdAt = Date.now();
  return fallbackPriceUsd;
}

export async function fetchEpwXPriceFromPancake(
  providerUrl: string,
  epwxWethPairAddress: string,
  epwxAddress: string,
  ethUsdConfig: EthUsdConfig
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

  const ethPriceUSD = await fetchEthUsdPrice(provider, ethUsdConfig);

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
