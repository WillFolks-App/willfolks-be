import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import qrcode from 'qrcode-generator';
import { DataSource } from 'typeorm';

import { ChainService } from '../chain/chain.service.js';
import { User, WalletTransaction } from '../entities/index.js';
import { env } from '../env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WalletService } from './wallet.service.js';

/** What the app needs to draw the QR in its own style and to confirm the purchase later. */
export interface QrPurchase {
  id: string;
  /** Signed summary of the purchase: the app sends it back to confirm it. */
  ticket: string;
  usdc: number;
  bob: number;
  bobPerUsd: number;
  expiresAt: string;
  /** The QR re-encoded from TilcAI's image, one string per row ("1" = dark module). Null if it could not be read. */
  modules: string[] | null;
  /** TilcAI's own PNG, base64. */
  image: string;
}

export type QrPurchaseStatus = { status: 'pending' | 'expired'; id: string } | { status: 'paid'; id: string; transaction: WalletTransaction };

interface Ticket {
  /** QR id at TilcAI. */
  q: string;
  /** User. */
  u: string;
  usdc: number;
  bob: number;
  /** Expiry, ms. */
  exp: number;
}

// jsqr is CommonJS with a `default` export: under Node's ESM interop the function sits one level down.
const jsQR = jsQRModule.default;

const round2 = (value: number) => Math.round(value * 100) / 100;
/** The note that marks a purchase as credited; it also keeps a QR from paying out twice. */
const noteFor = (qrId: string) => `QR ${qrId}`;
/** Vendis dates are "Y-m-d H:i:s" in Bolivia time (UTC−4 all year). */
const boliviaDate = (date: Date) => new Date(date.getTime() - 4 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Buying USDC with a Bolivian bank QR (QR Simple). TilcAI issues the QR through the Vendis API
 * ("QR Dinámico para Pagos" v1.3); once the bank reports it paid, the backend sends the USDC to
 * the user's wallet on Monad and records the deposit.
 */
@Injectable()
export class QrPurchaseService {
  private readonly log = new Logger(QrPurchaseService.name);
  private token?: Promise<string>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly chain: ChainService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
  ) {}

  get enabled(): boolean {
    return env.tilcai.enabled && Boolean(env.tilcai.qr.url && env.tilcai.qr.email && env.tilcai.qr.password);
  }

  /** Public terms, shown before buying. */
  config() {
    const { bobPerUsd, minUsdc, maxUsdc, expiresMinutes } = env.tilcai.qr;
    return { enabled: this.enabled, currency: 'BOB' as const, bobPerUsd, minUsdc, maxUsdc, expiresMinutes };
  }

  async create(userId: string, usdc: number): Promise<QrPurchase> {
    this.requireEnabled();
    const { bobPerUsd, minUsdc, maxUsdc, expiresMinutes, deviceId } = env.tilcai.qr;
    if (usdc < minUsdc || usdc > maxUsdc) {
      throw new BadRequestException({ code: 'QR_AMOUNT', message: `Between ${minUsdc} and ${maxUsdc} USDC` });
    }
    if (env.chain.enabled) {
      const user = await this.dataSource.manager.findOneOrFail(User, { where: { id: userId }, select: { id: true, walletAddress: true } });
      if (!user.walletAddress) throw new BadRequestException({ code: 'WALLET_REQUIRED', message: 'Link a wallet before buying' });
    }

    const bob = round2(usdc * bobPerUsd);
    const expires = new Date(Date.now() + expiresMinutes * 60_000);
    const data = await this.call<{ qr_image: string; qr_url: string; qr_id: number }>('POST', '/api/v1/devices/simple-qr/generate', {
      device_id: deviceId,
      amount: bob.toFixed(2),
      modify_amount: false,
      is_multi_use: false,
      qr_expiration: boliviaDate(expires),
      description: `WillFolks ${usdc} USDC`,
    });
    const id = String(data.qr_id);
    this.log.log(`QR ${id}: Bs ${bob.toFixed(2)} for ${usdc} USDC (user ${userId})`);
    return {
      id,
      ticket: this.sign({ q: id, u: userId, usdc, bob, exp: expires.getTime() }),
      usdc,
      bob,
      bobPerUsd,
      expiresAt: expires.toISOString(),
      modules: this.modules(data.qr_image),
      image: data.qr_image,
    };
  }

  /** Asks TilcAI whether the QR was paid; the first time it is, pays the USDC and records the deposit. */
  async confirm(userId: string, rawTicket: string): Promise<QrPurchaseStatus> {
    this.requireEnabled();
    const ticket = this.verify(rawTicket, userId);
    const id = ticket.q;

    const credited = await this.credited(userId, id);
    if (credited) return { status: 'paid', id, transaction: credited };

    const state = await this.call<{ status: string; payments: { payment_amount: string }[] }>('GET', `/api/v1/devices/simple-qr/get/${encodeURIComponent(id)}`);
    const paid = (state.payments ?? []).reduce((sum, p) => sum + Number(p.payment_amount || 0), 0);
    if (state.status !== 'Pagado' || paid + 0.005 < ticket.bob) {
      const expired = state.status === 'Anulado' || state.status === 'Fallido' || (state.status === 'Pendiente' && Date.now() > ticket.exp);
      return { status: expired ? 'expired' : 'pending', id };
    }

    return this.dataSource.transaction(async (manager) => {
      // One payout per QR, even if the app asks twice at once or a second instance answers.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wf-qr-${id}`]);
      const again = await manager.findOneBy(WalletTransaction, { userId, type: 'deposit', note: noteFor(id) });
      if (again) return { status: 'paid' as const, id, transaction: again };

      let txHash: string | undefined;
      if (env.chain.enabled) {
        const user = await manager.findOneOrFail(User, { where: { id: userId }, select: { id: true, walletAddress: true } });
        if (!user.walletAddress) throw new BadRequestException({ code: 'WALLET_REQUIRED', message: 'Link a wallet before buying' });
        txHash = await this.chain.payUsdc(user.walletAddress, ticket.usdc, `wf-qr-${id}`);
      }
      const transaction = await this.wallet.record(manager, {
        userId,
        type: 'deposit',
        amount: ticket.usdc,
        method: 'fiat',
        note: noteFor(id),
        ...(txHash ? { txHash } : {}),
      });
      await this.notifications.push(manager, userId, 'wallet', 'deposit', { amount: ticket.usdc, reference: transaction.referenceCode }, { transactionId: transaction.id });
      this.log.log(`QR ${id} paid (Bs ${paid.toFixed(2)}): ${ticket.usdc} USDC to user ${userId}${txHash ? ` tx=${txHash}` : ''}`);
      return { status: 'paid' as const, id, transaction };
    });
  }

  private credited(userId: string, id: string) {
    return this.dataSource.manager.findOneBy(WalletTransaction, { userId, type: 'deposit', note: noteFor(id) });
  }

  private requireEnabled() {
    if (!this.enabled) throw new ServiceUnavailableException({ code: 'QR_DISABLED', message: 'QR purchases are not available' });
  }

  // ── QR image ─────────────────────────────────────────────────────────────

  /**
   * Reads the content of TilcAI's PNG and encodes it again at level H (30 % recovery), so the
   * app can draw it with its own colours and cover the centre with its badge. Any reader still
   * gets the same content the bank issued.
   */
  modules(base64Png: string): string[] | null {
    try {
      const png = PNG.sync.read(Buffer.from(base64Png, 'base64'));
      const read = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
      if (!read) return null;
      const qr = qrcode(0, 'H');
      qr.addData(read.data, 'Byte');
      qr.make();
      const size = qr.getModuleCount();
      return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => (qr.isDark(row, col) ? '1' : '0')).join(''));
    } catch (error) {
      this.log.warn(`could not read the QR image: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ── Ticket ───────────────────────────────────────────────────────────────

  private mac(body: string) {
    return createHmac('sha256', `wf-qr:${env.jwtSecret}`).update(body).digest('base64url');
  }

  private sign(ticket: Ticket): string {
    const body = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  private verify(raw: string, userId: string): Ticket {
    const [body, mac] = String(raw).split('.');
    const expected = body ? this.mac(body) : '';
    const ok = Boolean(body && mac && mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)));
    let ticket: Ticket | null = null;
    try {
      ticket = ok ? (JSON.parse(Buffer.from(body!, 'base64url').toString()) as Ticket) : null;
    } catch {
      ticket = null;
    }
    if (!ticket || ticket.u !== userId) throw new BadRequestException({ code: 'QR_TICKET', message: 'Unknown purchase' });
    return ticket;
  }

  // ── Vendis API ───────────────────────────────────────────────────────────

  private login(): Promise<string> {
    return (this.token ??= this.request<{ access_token: string }>('POST', '/api/v1/login', undefined, {
      email: env.tilcai.qr.email,
      password: env.tilcai.qr.password,
      token_name: 'willfolks-be',
    })
      .then((r) => r.access_token)
      .catch((error) => {
        this.token = undefined;
        throw error;
      }));
  }

  /** Calls the API with the session token; logs in again once if it expired. */
  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.login();
      try {
        const answer = await this.request<{ success?: boolean; data: T }>(method, path, token, body);
        return answer.data;
      } catch (error) {
        if (attempt === 0 && error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED) {
          this.token = undefined;
          continue;
        }
        // A 401 here is TilcAI refusing our credentials, not the user's session.
        if (error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED) {
          throw new HttpException({ code: 'QR_SERVICE', message: 'The QR service refused the credentials' }, HttpStatus.BAD_GATEWAY);
        }
        throw error;
      }
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, token?: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${env.tilcai.qr.url}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      this.log.warn(`QR ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpException({ code: 'QR_UNREACHABLE', message: 'The QR service did not answer' }, HttpStatus.BAD_GATEWAY);
    }
    const answer = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok || !answer) {
      this.log.warn(`QR ${method} ${path}: HTTP ${res.status} ${answer?.message ?? ''}`);
      const status = res.status === 401 ? HttpStatus.UNAUTHORIZED : res.status === 404 ? HttpStatus.NOT_FOUND : HttpStatus.BAD_GATEWAY;
      throw new HttpException({ code: 'QR_SERVICE', message: answer?.message ?? `HTTP ${res.status}` }, status);
    }
    return answer;
  }
}
