import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup.js';

/**
 * Walks the API the way the mobile app does, against the local Postgres container
 * (willfolks-database). Every run signs up its own two users and deletes them at the
 * end, so the seeded data is left untouched.
 */
describe('WillFolks API (e2e)', () => {
  let app: NestExpressApplication;
  let http: App;

  const run = Date.now().toString(36);
  const today = new Date().toISOString().slice(0, 10);
  const nextMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const ana = { email: `e2e-ana-${run}@willfolks.test`, username: `ana_${run}`, token: '', id: '' };
  const leo = { email: `e2e-leo-${run}@willfolks.test`, username: `leo_${run}`, token: '', id: '' };

  // 1×1 transparent PNG standing in for a proof photo.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  const api = (user: { token: string }) => ({
    get: (path: string) => request(http).get(path).auth(user.token, { type: 'bearer' }),
    post: (path: string, body?: object) => request(http).post(path).auth(user.token, { type: 'bearer' }).send(body),
    patch: (path: string, body?: object) => request(http).patch(path).auth(user.token, { type: 'bearer' }).send(body),
    put: (path: string, body?: object) => request(http).put(path).auth(user.token, { type: 'bearer' }).send(body),
    delete: (path: string) => request(http).delete(path).auth(user.token, { type: 'bearer' }),
  });

  const alarmGoal = (overrides: object = {}) => ({
    kind: 'alarm',
    title: 'Wake up 06:30',
    stakeAmount: 5,
    endDate: nextMonth,
    repeatDays: [1, 2, 3, 4, 5],
    alarm: { targetTime: '06:30', reactionSeconds: 60 },
    ...overrides,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    for (const user of [ana, leo]) {
      if (user.token) await api(user).delete('/users/me');
    }
    await app.close();
  });

  describe('health and auth', () => {
    it('reports the database as up', async () => {
      const response = await request(http).get('/health').expect(200);
      expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
    });

    it('rejects calls without a token', async () => {
      await request(http).get('/users/me').expect(401);
      await request(http).get('/goals').auth('not-a-token', { type: 'bearer' }).expect(401);
    });

    it('signs up on first login and signs in on the second', async () => {
      for (const user of [ana, leo]) {
        const first = await request(http).post('/auth/login').send({ email: user.email, locale: 'es' }).expect(200);
        expect(first.body.isNew).toBe(true);
        expect(first.body.user.onboardingCompletedAt).toBeNull();
        user.token = first.body.accessToken;
        user.id = first.body.user.id;
      }
      const again = await request(http).post('/auth/login').send({ email: ana.email }).expect(200);
      expect(again.body).toMatchObject({ isNew: false, user: { id: ana.id } });
    });

    it('validates the login body', async () => {
      await request(http).post('/auth/login').send({ email: 'nope' }).expect(400);
      await request(http).post('/auth/login').send({ email: ana.email, admin: true }).expect(400);
    });
  });

  describe('profile, settings and device', () => {
    it('completes onboarding with a profile', async () => {
      for (const user of [ana, leo]) {
        const response = await api(user)
          .patch('/users/me', { username: user.username, displayName: user.username, onboardingCompleted: true })
          .expect(200);
        expect(response.body).toMatchObject({ username: user.username, displayName: user.username, email: user.email });
        expect(response.body.onboardingCompletedAt).not.toBeNull();
      }
    });

    it('refuses a username that is taken or malformed', async () => {
      const taken = await api(leo).patch('/users/me', { username: ana.username.toUpperCase() }).expect(409);
      expect(taken.body.code).toBe('USERNAME_TAKEN');
      await api(leo).patch('/users/me', { username: 'a b' }).expect(400);
      // A partial update leaves every other field as it was.
      const partial = await api(leo).patch('/users/me', { locationLabel: 'Madrid, ES' }).expect(200);
      expect(partial.body).toMatchObject({ username: leo.username, displayName: leo.username, locationLabel: 'Madrid, ES' });
    });

    it('stores an avatar and serves it back', async () => {
      const response = await api(ana).post('/users/me/avatar').attach('photo', png, { filename: 'me.png', contentType: 'image/png' }).expect(201);
      expect(response.body.avatarUrl).toMatch(/\/uploads\/avatars\/[0-9a-f-]+\.png$/);
      await request(http).get(new URL(response.body.avatarUrl, 'http://x').pathname).expect(200);
      await api(ana).post('/users/me/avatar').attach('photo', Buffer.from('hi'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
    });

    it('reads and updates settings', async () => {
      const defaults = await api(ana).get('/users/me/settings').expect(200);
      expect(defaults.body).toMatchObject({ theme: 'acid', haptics: true, showSeconds: true });
      const updated = await api(ana).put('/users/me/settings', { theme: 'void', haptics: false }).expect(200);
      expect(updated.body).toMatchObject({ theme: 'void', haptics: false, reminders: true });
      await api(ana).put('/users/me/settings', { theme: 'pink' }).expect(400);
    });

    it('registers the device and its permissions', async () => {
      const body = { installId: `install-${run}`, model: 'Pixel 9 Pro XL', osVersion: '16', usageAccessGranted: true };
      const created = await api(ana).put('/devices', body).expect(200);
      expect(created.body).toMatchObject({ usageAccessGranted: true, locationAccess: 'none' });
      const updated = await api(ana).put('/devices', { ...body, locationAccess: 'foreground' }).expect(200);
      expect(updated.body.id).toBe(created.body.id);
      expect((await api(ana).get('/devices').expect(200)).body).toHaveLength(1);
    });
  });

  describe('friends', () => {
    let requestId: string;

    it('finds people and sends a request', async () => {
      const found = await api(ana).get(`/users/search?q=${leo.username}`).expect(200);
      expect(found.body).toHaveLength(1);
      expect(found.body[0]).toMatchObject({ id: leo.id, friendship: null });
      expect(found.body[0].email).toBeUndefined();

      const sent = await api(ana).post('/friends', { userId: leo.id }).expect(201);
      requestId = sent.body.id;
      await api(ana).post('/friends', { userId: leo.id }).expect(409);
      await api(ana).post('/friends', { userId: ana.id }).expect(400);
    });

    it('lets only the addressee accept', async () => {
      await api(ana).patch(`/friends/${requestId}`, { status: 'accepted' }).expect(404);
      const incoming = await api(leo).get('/friends').expect(200);
      expect(incoming.body.incoming).toHaveLength(1);
      await api(leo).patch(`/friends/${requestId}`, { status: 'accepted' }).expect(200);

      const friends = await api(ana).get('/friends').expect(200);
      expect(friends.body.friends.map((friend: { user: { id: string } }) => friend.user.id)).toEqual([leo.id]);
      expect(friends.body.outgoing).toHaveLength(0);
    });
  });

  describe('wallet', () => {
    it('starts empty and refuses to stake or withdraw without funds', async () => {
      expect((await api(ana).get('/wallet').expect(200)).body).toMatchObject({ available: 0, inEscrow: 0 });
      const refused = await api(ana).post('/goals', alarmGoal()).expect(400);
      expect(refused.body.code).toBe('INSUFFICIENT_FUNDS');
      await api(ana).post('/wallet/withdrawals', { amount: 1 }).expect(400);
    });

    it('deposits, lists the movement and shows its voucher', async () => {
      const deposit = await api(ana).post('/wallet/deposits', { amount: 100, method: 'crypto' }).expect(201);
      expect(deposit.body).toMatchObject({ type: 'deposit', amount: 100, status: 'confirmed' });
      expect(deposit.body.referenceCode).toMatch(/^WF-[0-9A-F]{10}$/);
      await api(leo).post('/wallet/deposits', { amount: 20, method: 'fiat' }).expect(201);

      const voucher = await api(ana).get(`/wallet/transactions/${deposit.body.id}`).expect(200);
      expect(voucher.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      await api(leo).get(`/wallet/transactions/${deposit.body.id}`).expect(404);
      await api(ana).post('/wallet/deposits', { amount: -5, method: 'crypto' }).expect(400);
    });

    it('withdraws within the available balance', async () => {
      await api(ana).post('/wallet/withdrawals', { amount: 10 }).expect(201);
      expect((await api(ana).get('/wallet').expect(200)).body.available).toBe(90);
      expect((await api(ana).get('/wallet/transactions').expect(200)).body).toHaveLength(2);
    });
  });

  describe('alarm goals', () => {
    let goalId: string;

    it('creates the goal and moves the stake into escrow', async () => {
      await api(ana).post('/goals', { ...alarmGoal(), alarm: undefined }).expect(400);
      await api(ana).post('/goals', alarmGoal({ repeatDays: [7] })).expect(400);

      const created = await api(ana).post('/goals', alarmGoal({ maxAttempts: 2 })).expect(201);
      goalId = created.body.id;
      expect(created.body).toMatchObject({
        kind: 'alarm',
        status: 'active',
        stakeAmount: 5,
        alarm: { targetTime: '06:30', reactionSeconds: 60, vibrationEnabled: true },
        me: { role: 'owner', status: 'accepted' },
        progress: { successCount: 0, attemptsLeft: 2 },
      });
      expect(created.body.escrowTxHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await api(ana).get('/wallet').expect(200)).body).toMatchObject({ available: 85, inEscrow: 5 });
    });

    it('hides the goal from strangers', async () => {
      await api(leo).get(`/goals/${goalId}`).expect(404);
      await api(leo).post(`/goals/${goalId}/checkins`, { source: 'alarm', result: 'success' }).expect(404);
    });

    it('records one verdict per day', async () => {
      const first = await api(ana).post(`/goals/${goalId}/checkins`, { source: 'alarm', result: 'success', measuredValue: 12 }).expect(200);
      expect(first.body.checkin).toMatchObject({ result: 'success', scheduledFor: today, measuredValue: 12 });
      expect(first.body.goal.progress).toMatchObject({ successCount: 1, lastCheckin: { scheduledFor: today, result: 'success' } });

      const repeat = await api(ana).post(`/goals/${goalId}/checkins`, { source: 'alarm', result: 'fail' }).expect(200);
      expect(repeat.body.checkin).toMatchObject({ id: first.body.checkin.id, result: 'success' });
      expect((await api(ana).get('/pet').expect(200)).body).toMatchObject({ streak: 1, mood: 'happy' });
      expect((await api(ana).get(`/goals/${goalId}/checkins`).expect(200)).body).toHaveLength(1);
    });

    it('edits, pauses and resumes', async () => {
      const edited = await api(ana).patch(`/goals/${goalId}`, { title: 'Up at 7', alarm: { targetTime: '07:00' }, status: 'paused' }).expect(200);
      expect(edited.body).toMatchObject({ title: 'Up at 7', status: 'paused', alarm: { targetTime: '07:00' } });
      await api(ana).post(`/goals/${goalId}/checkins`, { source: 'alarm', result: 'success' }).expect(409);
      await api(ana).patch(`/goals/${goalId}`, { status: 'active' }).expect(200);
      await api(ana).patch(`/goals/${goalId}`, { status: 'completed' }).expect(400);
    });

    it('cancels and releases the stake', async () => {
      await api(ana).delete(`/goals/${goalId}`).expect(204);
      await api(ana).delete(`/goals/${goalId}`).expect(409);
      expect((await api(ana).get('/wallet').expect(200)).body).toMatchObject({ available: 90, inEscrow: 0 });
      const listed = await api(ana).get('/goals').expect(200);
      expect(listed.body.find((goal: { id: string }) => goal.id === goalId)).toBeUndefined();
    });
  });

  describe('app timer goals', () => {
    it('judges usage on the server and penalises once attempts run out', async () => {
      const created = await api(ana)
        .post('/goals', {
          kind: 'app_timer',
          title: 'Less Instagram',
          stakeAmount: 10,
          endDate: nextMonth,
          devTipPercent: 10,
          appTimer: { appPackage: 'com.instagram.android', appName: 'Instagram', maxDailyMinutes: 30 },
        })
        .expect(201);
      const path = `/goals/${created.body.id}/checkins`;
      await api(ana).post(path, { source: 'usage' }).expect(400);

      const within = await api(ana).post(path, { source: 'usage', measuredValue: 12 }).expect(200);
      expect(within.body.checkin.result).toBe('success');

      // Same day, the usage kept growing past the limit: the verdict worsens.
      const over = await api(ana).post(path, { source: 'usage', measuredValue: 45 }).expect(200);
      expect(over.body.checkin).toMatchObject({ id: within.body.checkin.id, result: 'fail', measuredValue: 45 });
      expect(over.body.goal).toMatchObject({ status: 'failed', progress: { failCount: 1, attemptsLeft: 0 } });

      // 10 USDC staked: 9 penalty + 1 developer tip, none of it back to the balance.
      expect((await api(ana).get('/wallet').expect(200)).body).toMatchObject({ available: 80, inEscrow: 0, penalized: 10 });
      expect((await api(ana).get('/pet').expect(200)).body).toMatchObject({ streak: 0, mood: 'sad' });
    });
  });

  describe('locator goals', () => {
    it('accepts a check-in only inside the radius', async () => {
      const created = await api(ana)
        .post('/goals', {
          kind: 'locator',
          title: 'Gym on time',
          stakeAmount: 5,
          endDate: nextMonth,
          location: { placeLabel: 'Gym', latitude: -16.5102, longitude: -68.1269, radiusM: 150, arriveBy: '07:30' },
        })
        .expect(201);
      const path = `/goals/${created.body.id}/checkins`;

      const far = await api(ana).post(path, { source: 'location', latitude: -16.52, longitude: -68.1269 }).expect(422);
      expect(far.body).toMatchObject({ code: 'TOO_FAR', radius: 150 });
      expect(far.body.distance).toBeGreaterThan(1000);

      const near = await api(ana).post(path, { source: 'location', latitude: -16.5103, longitude: -68.127 }).expect(200);
      expect(near.body.checkin).toMatchObject({ result: 'success', measuredUnit: 'meters' });
      expect(near.body.checkin.measuredValue).toBeLessThan(150);
    });
  });

  describe('AI goals and proofs', () => {
    const aiGoal = (ai: object) => ({ kind: 'ai', title: 'Clean my room', stakeAmount: 5, endDate: nextMonth, ai });

    it('auto-approves a photo proof when the AI is the judge', async () => {
      const created = await api(ana).post('/goals', aiGoal({ prompt: 'The bed is made and the floor is clear.' })).expect(201);
      const path = `/goals/${created.body.id}`;
      // Passing takes a proof; only a missed day can be reported directly.
      await api(ana).post(`${path}/checkins`, { source: 'manual', result: 'success' }).expect(400);
      await api(ana).post(`${path}/proofs`).field('note', 'no photo').expect(400);

      const sent = await api(ana).post(`${path}/proofs`).field('note', 'done!').attach('photo', png, { filename: 'room.png', contentType: 'image/png' }).expect(201);
      expect(sent.body.proof).toMatchObject({ status: 'approved', verifier: 'ai', note: 'done!' });
      expect(sent.body.goal.progress.successCount).toBe(1);
      expect((await api(ana).get(`${path}/proofs`).expect(200)).body).toHaveLength(1);

      const again = await api(ana).post(`${path}/proofs`).attach('photo', png, { filename: 'room.png', contentType: 'image/png' }).expect(409);
      expect(again.body.code).toBe('ALREADY_RESOLVED');
    });

    it('waits for a friend verdict, and a rejection costs the stake', async () => {
      await api(ana).post('/goals', aiGoal({ prompt: 'Homework done', verifier: 'friend' })).expect(400);
      const created = await api(ana).post('/goals', aiGoal({ prompt: 'Homework done', verifier: 'friend', verifierUserId: leo.id })).expect(201);

      const sent = await api(ana).post(`/goals/${created.body.id}/proofs`).attach('photo', png, { filename: 'hw.png', contentType: 'image/png' }).expect(201);
      expect(sent.body.proof).toMatchObject({ status: 'pending', verifier: 'friend', reviewerId: leo.id });
      expect(sent.body.goal.progress.pendingCount).toBe(1);

      const reviews = await api(leo).get('/proofs/reviews').expect(200);
      expect(reviews.body).toHaveLength(1);
      expect(reviews.body[0]).toMatchObject({ id: sent.body.proof.id, goalTitle: 'Clean my room', prompt: 'Homework done' });

      await api(ana).patch(`/proofs/${sent.body.proof.id}`, { approved: true }).expect(404);
      const verdict = await api(leo).patch(`/proofs/${sent.body.proof.id}`, { approved: false, reason: 'Page 3 is empty' }).expect(200);
      expect(verdict.body).toMatchObject({ status: 'rejected', verdictReason: 'Page 3 is empty' });
      await api(leo).patch(`/proofs/${sent.body.proof.id}`, { approved: true }).expect(409);

      expect((await api(ana).get(`/goals/${created.body.id}`).expect(200)).body.status).toBe('failed');
      expect((await api(leo).get('/proofs/reviews').expect(200)).body).toHaveLength(0);
    });
  });

  describe('shared goals', () => {
    it('invites a friend, and in a versus goal the loser pays the rival', async () => {
      const stranger = await request(http).post('/auth/login').send({ email: `e2e-mia-${run}@willfolks.test` }).expect(200);
      const notFriends = await api(ana).post('/goals', alarmGoal({ participantIds: [stranger.body.user.id] })).expect(400);
      expect(notFriends.body.code).toBe('NOT_FRIENDS');
      await request(http).delete('/users/me').auth(stranger.body.accessToken, { type: 'bearer' }).expect(204);

      const before = (await api(leo).get('/wallet').expect(200)).body.available;
      const created = await api(ana).post('/goals', alarmGoal({ participantIds: [leo.id], groupMode: 'vs' })).expect(201);
      const path = `/goals/${created.body.id}`;
      expect(created.body).toMatchObject({ isGroup: true, groupMode: 'vs' });

      const invited = (await api(leo).get('/goals').expect(200)).body;
      expect(invited).toHaveLength(1);
      expect(invited[0].me).toMatchObject({ role: 'participant', status: 'invited' });
      await api(leo).post(`${path}/checkins`, { source: 'alarm', result: 'success' }).expect(403);

      const joined = await api(leo).patch(`${path}/invitation`, { accept: true }).expect(200);
      expect(joined.body.me).toMatchObject({ status: 'accepted', stakeAmount: 5 });
      expect((await api(leo).get('/wallet').expect(200)).body).toMatchObject({ available: before - 5, inEscrow: 5 });

      // Ana oversleeps: her 5 USDC go to Leo, and the goal closes giving Leo his stake back.
      const missed = await api(ana).post(`${path}/checkins`, { source: 'alarm', result: 'fail' }).expect(200);
      expect(missed.body.goal.status).toBe('failed');
      expect((await api(leo).get('/wallet').expect(200)).body).toMatchObject({ available: before + 5, inEscrow: 0 });
    });
  });

  describe('pet, usage, notifications and dashboard', () => {
    it('feeds the pet and lets it rest', async () => {
      const fed = await api(ana).post('/pet/actions', { action: 'feed' }).expect(200);
      expect(fed.body.mood).toBe('happy');
      expect(fed.body.lastFedAt).not.toBeNull();
      const rested = await api(ana).post('/pet/actions', { action: 'rest' }).expect(200);
      expect(['idle', 'sad']).toContain(rested.body.mood);
      await api(ana).post('/pet/actions', { action: 'kick' }).expect(400);
    });

    it('upserts daily usage samples', async () => {
      const sample = { appPackage: 'com.instagram.android', appName: 'Instagram', usageDate: today, foregroundMinutes: 12 };
      await api(ana).put('/usage', { samples: [sample] }).expect(200);
      await api(ana).put('/usage', { samples: [{ ...sample, foregroundMinutes: 45 }] }).expect(200);
      const listed = await api(ana).get(`/usage?from=${today}&to=${today}`).expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].foregroundMinutes).toBe(45);
      await api(ana).put('/usage', { samples: [{ ...sample, foregroundMinutes: 5000 }] }).expect(400);
    });

    it('keeps an inbox written in the user locale', async () => {
      const inbox = await api(ana).get('/notifications').expect(200);
      expect(inbox.body.unread).toBeGreaterThan(5);
      expect(inbox.body.items.at(-1)).toMatchObject({ type: 'system', title: 'Bienvenido a WillFolks' });

      const one = inbox.body.items[0];
      expect((await api(ana).patch(`/notifications/${one.id}/read`).expect(200)).body.readAt).not.toBeNull();
      await api(leo).patch(`/notifications/${one.id}/read`).expect(404);
      await api(ana).post('/notifications/read-all').expect(200);
      expect((await api(ana).get('/notifications').expect(200)).body.unread).toBe(0);
    });

    it('summarises everything for the home screen', async () => {
      const response = await api(ana).get('/dashboard').expect(200);
      expect(response.body).toMatchObject({ unreadNotifications: 0, activeGoals: 2, balance: { inEscrow: 10 } });
      expect(response.body.feed.length).toBeGreaterThan(5);
      expect(response.body.feed[0]).toHaveProperty('tone');
    });
  });

  describe('account deletion', () => {
    it('removes the account and invalidates its token', async () => {
      await api(leo).delete('/users/me').expect(204);
      await api(leo).get('/users/me').expect(401);
      leo.token = '';
      expect((await api(ana).get('/friends').expect(200)).body.friends).toHaveLength(0);
    });
  });
});
