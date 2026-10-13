import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Pet } from '../entities/index.js';

export type PetEvent = 'feed' | 'play' | 'poke' | 'staked' | 'success' | 'fail';

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** Energy change of each event; a failed check also resets the streak. */
const ENERGY: Record<PetEvent, number> = { feed: 14, play: 9, poke: 3, staked: 6, success: 12, fail: -25 };

@Injectable()
export class PetService {
  constructor(private readonly dataSource: DataSource) {}

  async get(userId: string, manager: EntityManager = this.dataSource.manager): Promise<Pet> {
    const existing = await manager.findOneBy(Pet, { userId });
    if (existing) return existing;
    await manager.createQueryBuilder().insert().into(Pet).values({ userId }).orIgnore().execute();
    return manager.findOneByOrFail(Pet, { userId });
  }

  async apply(userId: string, event: PetEvent, manager: EntityManager = this.dataSource.manager): Promise<Pet> {
    const pet = await this.get(userId, manager);
    pet.energy = clamp(pet.energy + ENERGY[event]);
    pet.mood = event === 'fail' ? 'sad' : 'happy';
    if (event === 'success') {
      pet.streak += 1;
      pet.bestStreak = Math.max(pet.bestStreak, pet.streak);
    }
    if (event === 'fail') pet.streak = 0;
    if (event === 'feed') pet.lastFedAt = new Date();
    return manager.save(pet);
  }

  /** A happy pet settles back down; a drained one stays sad. */
  async rest(userId: string): Promise<Pet> {
    const pet = await this.get(userId);
    pet.mood = pet.energy < 35 ? 'sad' : 'idle';
    return this.dataSource.manager.save(pet);
  }

  async rename(userId: string, name: string): Promise<Pet> {
    const pet = await this.get(userId);
    pet.name = name;
    return this.dataSource.manager.save(pet);
  }
}
