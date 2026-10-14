import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { type Hex, getAddress } from 'viem';
import { EvmRelayer, Tilcai, TilcaiError, type RelayedTransaction } from 'tilcai-sdk';
import { X402Facilitator } from 'tilcai-sdk/x402';

import { env } from '../env.js';

const trimAmount = (amount: number) => amount.toFixed(6).replace(/\.?0+$/, '');

/**
 * The only place that talks to TilcAI (tilcai-sdk). Everything here is opt-in: with
 * `TILCAI_ENABLED=false` nothing in the backend reaches this class.
 */
@Injectable()
export class TilcaiService {
  private readonly log = new Logger(TilcaiService.name);
  private tilcaiApi?: Tilcai;
  private accountsClient?: Tilcai;
  private evmRelayer?: EvmRelayer;
  private x402Facilitator?: X402Facilitator;

  get enabled(): boolean {
    return env.tilcai.enabled;
  }

  /** The faucet's USDC comes from TilcAI's vault. */
  get vaultFaucet(): boolean {
    return env.tilcai.enabled && env.tilcai.vaultFaucet;
  }

  /** Fiat deposits are paid by TilcAI's vault. */
  get vaultDeposits(): boolean {
    return env.tilcai.enabled && env.tilcai.vaultDeposits;
  }

  /** `resolve`, `claim` and `reclaim` go through TilcAI's relayer. */
  get relayValidation(): boolean {
    return env.tilcai.relayValidation;
  }

  get judgeEnabled(): boolean {
    return env.tilcai.judge.enabled;
  }

  get accountsEnabled(): boolean {
    return env.tilcai.enabled && Boolean(env.tilcai.apiUrl && (env.tilcai.accountsApiKey || env.tilcai.apiKey));
  }

  private requireEnabled() {
    if (!env.tilcai.enabled) throw new ServiceUnavailableException({ code: 'TILCAI_DISABLED', message: 'TilcAI is not enabled' });
  }

  /** Client of the TilcAI API with the operator key (vault, payments). */
  get api(): Tilcai {
    this.requireEnabled();
    if (!env.tilcai.apiUrl || !env.tilcai.apiKey) {
      throw new ServiceUnavailableException({ code: 'TILCAI_NOT_CONFIGURED', message: 'TILCAI_API_URL and TILCAI_API_KEY are required' });
    }
    return (this.tilcaiApi ??= new Tilcai({
      baseUrl: env.tilcai.apiUrl,
      apiKey: env.tilcai.apiKey,
      environment: env.tilcai.environment,
      timeoutMs: 60_000,
    }));
  }

  /** Client with the tenant key that carries `accounts:read` and `accounts:write`. */
  get accounts(): Tilcai {
    this.requireEnabled();
    if (!this.accountsEnabled) {
      throw new ServiceUnavailableException({ code: 'TILCAI_NOT_CONFIGURED', message: 'TILCAI_ACCOUNTS_API_KEY (or TILCAI_API_KEY) is required' });
    }
    return (this.accountsClient ??= new Tilcai({
      baseUrl: env.tilcai.apiUrl,
      apiKey: env.tilcai.accountsApiKey || env.tilcai.apiKey,
      environment: env.tilcai.environment,
      timeoutMs: 90_000,
    }));
  }

  get relayer(): EvmRelayer {
    this.requireEnabled();
    if (!env.tilcai.relayerUrl || !env.tilcai.relayerApiKey) {
      throw new ServiceUnavailableException({ code: 'TILCAI_NOT_CONFIGURED', message: 'TILCAI_RELAYER_URL and TILCAI_RELAYER_API_KEY are required' });
    }
    return (this.evmRelayer ??= new EvmRelayer({
      url: env.tilcai.relayerUrl,
      apiKey: env.tilcai.relayerApiKey,
      relayerId: env.tilcai.relayerId,
    }));
  }

  get facilitator(): X402Facilitator {
    this.requireEnabled();
    if (!env.tilcai.relayerUrl || !env.tilcai.relayerApiKey) {
      throw new ServiceUnavailableException({ code: 'TILCAI_NOT_CONFIGURED', message: 'TILCAI_RELAYER_URL and TILCAI_RELAYER_API_KEY are required' });
    }
    return (this.x402Facilitator ??= new X402Facilitator({
      url: env.tilcai.relayerUrl,
      apiKey: env.tilcai.relayerApiKey,
      timeoutMs: 120_000,
    }));
  }

  /**
   * Pays `amountUsdc` of the vault's USDC to `to` on Monad and waits for it to land.
   * `reference` is the purchase id: TilcAI pays each reference once, so a retry cannot pay twice.
   */
  async disburse(to: string, amountUsdc: number, reference: string): Promise<{ id: string; txHash: Hex }> {
    try {
      const created = await this.api.vault.disburse({
        network: 'monad',
        to: getAddress(to),
        amount: trimAmount(amountUsdc),
        reference,
        idempotencyKey: reference,
      });
      const done = await this.api.vault.waitForConfirmation(created.disbursement.id, { timeoutMs: 120_000, intervalMs: 1_500 });
      if (!done.txHash) throw new Error('the vault confirmed a disbursement without a hash');
      this.log.log(`vault paid ${trimAmount(amountUsdc)} USDC to ${to} (${reference}) tx=${done.txHash}`);
      return { id: done.id, txHash: done.txHash as Hex };
    } catch (error) {
      throw this.asHttp(error, 'TILCAI_VAULT');
    }
  }

  /**
   * Sends a contract call from TilcAI's relayer: its account is `msg.sender` and pays the gas.
   * The caller keeps the authority: the call must carry a signature the contract checks.
   */
  async relay(to: string, data: Hex): Promise<RelayedTransaction & { hash: Hex }> {
    try {
      const tx = await this.relayer.sendAndWait({ to, data }, { timeoutMs: 120_000, intervalMs: 1_500 });
      return { ...tx, hash: tx.hash as Hex };
    } catch (error) {
      throw this.asHttp(error, 'TILCAI_RELAY');
    }
  }

  async status() {
    if (!this.enabled) return { enabled: false as const };
    const capabilities = {
      vaultFaucet: this.vaultFaucet,
      vaultDeposits: this.vaultDeposits,
      relayValidation: this.relayValidation,
      aiJudge: this.judgeEnabled,
      accounts: this.accountsEnabled,
    };
    const [health, relayer] = await Promise.all([
      env.tilcai.apiUrl ? new Tilcai({ baseUrl: env.tilcai.apiUrl, environment: env.tilcai.environment, timeoutMs: 8_000 }).health().catch(() => null) : null,
      env.tilcai.relayerUrl && env.tilcai.relayerApiKey ? this.relayer.address().catch(() => null) : null,
    ]);
    return {
      enabled: true as const,
      environment: env.tilcai.environment,
      api: health ? { reachable: true, env: health.env, relayer: health.relayer, networks: health.networks } : { reachable: false },
      relayer: relayer ? { id: env.tilcai.relayerId, address: relayer } : null,
      capabilities,
    };
  }

  /** Keeps TilcAI's error code (`BUDGET`, `PAUSED`…) visible to the app without leaking its internals. */
  private asHttp(error: unknown, prefix: string): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof TilcaiError) {
      this.log.warn(`${prefix}: ${error.code} ${error.message}`);
      const status = error.retryable || error.status === 0 ? HttpStatus.BAD_GATEWAY : error.status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.UNPROCESSABLE_ENTITY;
      return new HttpException({ code: `${prefix}_${error.code}`, message: error.message }, status);
    }
    this.log.error(`${prefix}: ${String(error)}`);
    return new HttpException({ code: `${prefix}_ERROR`, message: error instanceof Error ? error.message : String(error) }, HttpStatus.BAD_GATEWAY);
  }
}
