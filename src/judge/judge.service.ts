import { Injectable, Logger } from '@nestjs/common';
import { privateKeyToAccount } from 'viem/accounts';
import { decimalToAtomic, evmSignerFromViem } from 'tilcai-sdk';
import { Paywall, x402Fetch, type SettleResponse } from 'tilcai-sdk/x402';

import { env } from '../env.js';
import { TilcaiService } from '../tilcai/tilcai.service.js';

export interface JudgeRequest {
  title: string;
  prompt: string;
  /** Absolute URL of the photo the user submitted. */
  photoUrl: string;
}

export interface Verdict {
  approved: boolean;
  reason: string;
  judge: string;
}

export interface PaidVerdict extends Verdict {
  /** The x402 settlement that paid for this verdict (a USDC transfer on Monad). */
  payment: SettleResponse;
}

const JUDGE_ID = 'willfolks-stub-v1';

/**
 * The AI judge as a paid service (x402). The seller side is `POST /judge/verify` behind a
 * `Paywall`; the buyer side is the backend itself, paying from the treasury per verification.
 * The model behind it is still a stub: any non-empty image passes. What is real is the rail:
 * each verdict settles 0.01 USDC on Monad through TilcAI's facilitator.
 */
@Injectable()
export class JudgeService {
  private readonly log = new Logger(JudgeService.name);
  private seller?: Paywall;

  constructor(private readonly tilcai: TilcaiService) {}

  get enabled(): boolean {
    return this.tilcai.judgeEnabled;
  }

  /** Who is paid for judging: `AI_JUDGE_PAYTO`, or the attestor's address. */
  get payTo(): string {
    if (env.tilcai.judge.payTo) return env.tilcai.judge.payTo;
    return privateKeyToAccount(this.hex(env.chain.attestorKey)).address;
  }

  get paywall(): Paywall {
    return (this.seller ??= new Paywall({
      facilitator: this.tilcai.facilitator,
      resource: { description: 'WillFolks AI proof judge', mimeType: 'application/json' },
      accepts: [{ network: 'monad', environment: env.tilcai.environment, amount: env.tilcai.judge.price, payTo: this.payTo }],
    }));
  }

  /** Where the buyer calls the judge: another service, or this one. */
  get url(): string {
    const base = env.tilcai.judge.url || `http://127.0.0.1:${env.port}`;
    return `${base}/judge/verify`;
  }

  // ------------------------------------------------------------------ seller

  /** The model. Stub: an image that downloads and is not empty is approved. */
  async decide(request: JudgeRequest): Promise<Verdict> {
    try {
      const response = await fetch(request.photoUrl, { signal: AbortSignal.timeout(15_000) });
      const type = response.headers.get('content-type') ?? '';
      const size = (await response.arrayBuffer()).byteLength;
      if (!response.ok || !type.startsWith('image/') || size === 0) {
        return { approved: false, reason: 'The proof is not a readable image.', judge: JUDGE_ID };
      }
      return { approved: true, reason: `Approved by the AI judge (${JUDGE_ID}): image received for "${request.title}".`, judge: JUDGE_ID };
    } catch {
      return { approved: false, reason: 'The proof could not be downloaded.', judge: JUDGE_ID };
    }
  }

  // ------------------------------------------------------------------- buyer

  /** Pays for one verdict from the treasury and returns it with the settlement that paid for it. */
  async buy(request: JudgeRequest): Promise<PaidVerdict> {
    const treasury = privateKeyToAccount(this.hex(env.chain.treasuryKey));
    const pay = x402Fetch({
      wallet: { evm: evmSignerFromViem(treasury) },
      // Never pay more than the configured price per verdict.
      maxAmountAtomic: decimalToAtomic(env.tilcai.judge.price, 6),
    });
    const response = await pay(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`AI judge answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payment = response.settlement;
    if (!payment?.success) throw new Error('AI judge answered without a settled payment');
    const verdict = (await response.json()) as Verdict;
    this.log.log(`AI judge verdict approved=${verdict.approved} paid with tx=${payment.transaction}`);
    return { ...verdict, payment };
  }

  private hex(key: string): `0x${string}` {
    return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
  }
}
