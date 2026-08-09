import { config } from '../config';
import { AzbitExchangeService } from './azbit-exchange.service';
import { BiconomyExchangeService } from './biconomy-exchange.service';
import { ExchangeService } from './exchange.types';

export function createExchangeService(): ExchangeService {
  if (config.exchange.name === 'azbit') {
    return new AzbitExchangeService();
  }

  return new BiconomyExchangeService();
}
