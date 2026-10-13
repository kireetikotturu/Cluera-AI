import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { usageService } from '../lib/usage/service';
import { createUsageCoordinator } from '../lib/usage/coordinator';
import { attachRelaySession } from '../lib/accountRelay/session';
import { STAGING_DATABASE, STAGING_SITE } from '../lib/accountRelay/config';

// Real PL/pgSQL, isolated process-local fixture. No live customer/provider calls.
let db: PGlite;
const user = '00000000-0000-4000-8000-000000000811', sid = '00000000-0000-4000-8000-000000000812';
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);`);
  for (const file of ['20261004024730_customer_account_foundation', '20261004064105_shared_usage_reservations']) {
    await db.exec(readFileSync(`../supabase/migrations/${file}.sql`, 'utf8'));
  }
  await db.query('insert into auth.users values($1,$2,now())', [user, 'relay-fixture@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null)', [sid, user]);
}, 60000);
afterAll(async () => db?.close());
class Peer extends EventEmitter {
  readyState = WebSocket.OPEN as number; bufferedAmount = 0;
  send(raw: string) { this.emit('output', JSON.parse(raw)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
  input(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
describe('relay wired through the actual transactional usage service', () => {
  it('reserves shared trial before upstream, settles once on disconnect, and denies revoked Auth session', async () => {
    const pending: Promise<unknown>[] = [];
    const usage = usageService((_name, args) => {
      const task = db.query<{ result: unknown }>('select public.customer_usage_command($1,$2,$3,$4,$5) as result',
        [args.p_user_id, args.p_session_id, args.p_run_id, args.p_sequence, args.p_action])
        .then(value => ({ data: value.rows[0].result, error: null }));
      pending.push(task); return task;
    }, { SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_ORIGIN: STAGING_SITE, NEXT_PUBLIC_SUPABASE_URL: STAGING_DATABASE });
    let providerCalls = 0;
    const make = async () => {
      const peer = new Peer();
      const opened = new Promise<void>(resolve => peer.on('output', v => { if (v.type === 'ready') resolve(); }));
      attachRelaySession(peer as unknown as WebSocket, { authorize: async () => ({ remainingTokenMs: 60000,
        createRun: () => createUsageCoordinator(c => usage.command({ userId: user, sessionId: sid }, c)) }),
      providers: { generate: async (_input, guard, emit) => { guard.assertActive(); providerCalls++; emit('fixture answer'); },
        audio: () => { throw Error('not used'); } } });
      peer.input({ type: 'authenticate', accessToken: 'synthetic-access-fixture-only' }); await opened;
      return peer;
    };
    const peers = await Promise.all([make(), make()]);
    const done = peers.map(peer => new Promise<void>(resolve => peer.on('output', v => { if (v.type === 'answerDone') resolve(); })));
    for (const peer of peers) peer.input({ type: 'generate', id: 'a', prompt: 'fixture' });
    await Promise.all(done); expect(providerCalls).toBe(2);
    const grants = await db.query<{ reserved_ms: number }>('select reserved_ms from public.customer_usage_grants');
    expect(grants.rows).toHaveLength(1); expect(Number(grants.rows[0].reserved_ms)).toBe(60000);
    await db.exec("update public.customer_usage_windows set starts_at=starts_at-interval '2 seconds',expires_at=expires_at-interval '2 seconds'");
    for (const peer of peers) peer.close(); await new Promise(resolve => setTimeout(resolve, 0)); await Promise.all(pending);
    const balance = await db.query<{ reserved_ms: number; spent_ms: number }>('select reserved_ms,spent_ms from public.customer_usage_grants');
    expect(Number(balance.rows[0].reserved_ms)).toBe(0); expect(Number(balance.rows[0].spent_ms)).toBeGreaterThanOrEqual(4000);
    expect((await db.query('select * from public.customer_usage_settlements')).rows).toHaveLength(2);
    await db.query('delete from auth.sessions where id=$1', [sid]);
    const revoked = await make(); const ended = new Promise<void>(resolve => revoked.once('close', resolve));
    revoked.input({ type: 'generate', id: 'b', prompt: 'fixture' }); await ended;
    expect(providerCalls).toBe(2); expect((await db.query('select * from public.customer_trial_grants')).rows).toHaveLength(1);
  });
});
