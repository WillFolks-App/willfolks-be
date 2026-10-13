import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { Notification, NotificationType, User } from '../entities/index.js';

type Params = Record<string, string | number>;

/** Notification copy, in the two languages the app ships. */
const COPY = {
  welcome: {
    en: ['Welcome to WillFolks', 'Deposit, stake on a goal and keep your streak alive.'],
    es: ['Bienvenido a WillFolks', 'Deposita, apuesta por una meta y mantén tu racha.'],
  },
  goalCreated: {
    en: ['Stake locked in', '{title} · {amount} USDC in escrow.'],
    es: ['Apuesta bloqueada', '{title} · {amount} USDC en custodia.'],
  },
  goalInvite: {
    en: ['{name} challenged you', '{title} · {amount} USDC at stake.'],
    es: ['{name} te retó', '{title} · {amount} USDC en juego.'],
  },
  inviteAccepted: {
    en: ['{name} joined your goal', '{title}'],
    es: ['{name} se unió a tu meta', '{title}'],
  },
  checkinSuccess: {
    en: ['Goal check passed', '{title} · your stake is safe.'],
    es: ['Control superado', '{title} · tu apuesta sigue a salvo.'],
  },
  checkinFail: {
    en: ['Goal check missed', '{title} · {left} attempt(s) left.'],
    es: ['Control fallado', '{title} · te quedan {left} intento(s).'],
  },
  goalFailed: {
    en: ['Stake locked', '{title} · {amount} USDC locked for {days} days.'],
    es: ['Apuesta bloqueada', '{title} · {amount} USDC bloqueados por {days} días.'],
  },
  goalCompleted: {
    en: ['Goal completed', '{title} · {amount} USDC released to your balance.'],
    es: ['Meta completada', '{title} · {amount} USDC liberados a tu saldo.'],
  },
  goalCancelled: {
    en: ['Goal cancelled', '{title} · {amount} USDC released to your balance.'],
    es: ['Meta cancelada', '{title} · {amount} USDC liberados a tu saldo.'],
  },
  escrowReleased: {
    en: ['Stake returned', '{title} · {amount} USDC is back in your wallet.'],
    es: ['Apuesta devuelta', '{title} · {amount} USDC volvieron a tu wallet.'],
  },
  escrowUnlocked: {
    en: ['Lock finished', '{title} · {amount} USDC returned to your wallet.'],
    es: ['Bloqueo terminado', '{title} · {amount} USDC volvieron a tu wallet.'],
  },
  faucet: {
    en: ['Test funds received', '+{amount} USDC and gas for the Monad testnet.'],
    es: ['Fondos de prueba recibidos', '+{amount} USDC y gas para la testnet de Monad.'],
  },
  reward: {
    en: ['You won a bet', '{title} · +{amount} USDC.'],
    es: ['Ganaste una apuesta', '{title} · +{amount} USDC.'],
  },
  friendRequest: {
    en: ['{name} wants to be your friend', 'Accept the request to challenge them.'],
    es: ['{name} quiere ser tu amigo', 'Acepta la solicitud para retarlo.'],
  },
  friendAccepted: {
    en: ['{name} accepted your request', 'You can now share goals.'],
    es: ['{name} aceptó tu solicitud', 'Ya pueden compartir metas.'],
  },
  proofReview: {
    en: ['{name} needs your verdict', '{title} · review the proof.'],
    es: ['{name} necesita tu veredicto', '{title} · revisa la evidencia.'],
  },
  proofPending: {
    en: ['Proof sent', '{title} · waiting for the verdict.'],
    es: ['Evidencia enviada', '{title} · esperando el veredicto.'],
  },
  deposit: {
    en: ['Deposit confirmed', '+{amount} USDC · {reference}'],
    es: ['Depósito confirmado', '+{amount} USDC · {reference}'],
  },
  withdrawal: {
    en: ['Withdrawal sent', '-{amount} USDC · {reference}'],
    es: ['Retiro enviado', '-{amount} USDC · {reference}'],
  },
} satisfies Record<string, Record<'en' | 'es', [string, string]>>;

export type NotificationCopy = keyof typeof COPY;

const fill = (template: string, params: Params) =>
  template.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? ''));

@Injectable()
export class NotificationsService {
  constructor(@InjectRepository(Notification) private readonly notifications: Repository<Notification>) {}

  /** Stores a notification written in the recipient's language. */
  async push(
    manager: EntityManager,
    userId: string,
    type: NotificationType,
    copy: NotificationCopy,
    params: Params = {},
    data: Notification['data'] = {},
  ): Promise<void> {
    const user = await manager.findOne(User, { where: { id: userId }, select: { id: true, locale: true } });
    if (!user) return;
    const [title, body] = COPY[copy][user.locale.startsWith('es') ? 'es' : 'en'];
    await manager.insert(Notification, {
      userId,
      type,
      title: fill(title, params).slice(0, 120),
      body: fill(body, params),
      data,
    });
  }

  async list(userId: string, limit: number) {
    const [items, unread] = await Promise.all([
      this.notifications.find({ where: { userId }, order: { createdAt: 'DESC' }, take: limit }),
      this.unreadCount(userId),
    ]);
    return { unread, items };
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.countBy({ userId, readAt: IsNull() });
  }

  async markRead(userId: string, id: string): Promise<Notification> {
    const notification = await this.notifications.findOneBy({ id, userId });
    if (!notification) throw new NotFoundException('Notification not found');
    if (!notification.readAt) {
      notification.readAt = new Date();
      await this.notifications.save(notification);
    }
    return notification;
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notifications.update({ userId, readAt: IsNull() }, { readAt: new Date() });
    return { updated: result.affected ?? 0 };
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.notifications.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('Notification not found');
  }
}
