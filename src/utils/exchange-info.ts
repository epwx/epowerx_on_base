import axios from 'axios';

export interface PairInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  minQty?: number;
  stepSize?: number;
  minNotional?: number;
}

let cachedInfo: PairInfo | null = null;

export async function getEPWXPairInfo(): Promise<PairInfo> {
  if (cachedInfo) return cachedInfo;
  const url = 'https://api.biconomy.com/api/v1/exchangeInfo';
  const resp = await axios.get(url);
  const arr = resp.data;
  if (!Array.isArray(arr)) throw new Error('exchangeInfo: Unexpected response');
  const info = arr.find((x: any) => x.symbol === 'EPWX_USDT');
  if (!info) throw new Error('exchangeInfo: EPWX_USDT not found');
  cachedInfo = info;
  return info;
}
