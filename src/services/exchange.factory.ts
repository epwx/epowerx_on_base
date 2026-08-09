import { config } from '../config';
import { AzbitExchangeService } from './azbit-exchange.service';
import { BiconomyExchangeService } from './biconomy-exchange.service';
import { ExchangeService } from './exchange.types';
import { ShadowExchangeService } from './shadow-exchange.service';

export function createExchangeService(): ExchangeService {
  if (config.exchange.name === 'azbit') {
    const azbitExchange = new AzbitExchangeService();
    return config.azbitExchange.shadowMode
      ? new ShadowExchangeService(azbitExchange)
      : azbitExchange;
  }

  return new BiconomyExchangeService();
}
