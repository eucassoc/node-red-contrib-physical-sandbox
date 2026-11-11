/**
 * A small Node-RED for the hub and its routes:
 *
 * - `httpAdmin` is a real express app (the one Node-RED uses), with no body parser in front, so
 *   the routes read their own bodies; `listen()` serves it on a free port.
 * - `comms.publish` keeps the retained messages per topic and sends every message to every pane,
 *   as Node-RED's runtime comms does (each message goes out as JSON); `pane()` subscribes a new one,
 *   which is sent the retained messages at once.
 * - `auth.needsPermission(p)` lets every request through and notes which permission each route asked.
 *
 * `fakeClock()` is a clock whose time moves only by `advance(ms)`, running the timers that fall due
 * in their order.
 */
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const require = createRequire(import.meta.url);
const express = require('express');

export interface Pane { received: { topic: string; data: any }[]; latest(topic: string): any }

export function fakeRed(opts: { userDir: string; settings?: Record<string, unknown> }) {
  const retained = new Map<string, string>();
  const panes: Pane[] = [];
  const published: { topic: string; data: any; retain: boolean }[] = [];
  const permissions = new Map<string, string>();
  const app = express();

  const newPane = (): Pane => {
    const pane: Pane = {
      received: [],
      latest(topic) {
        for (let i = this.received.length - 1; i >= 0; i -= 1) if (this.received[i].topic === topic) return this.received[i].data;
        return undefined;
      },
    };
    for (const [topic, text] of retained) if (topic.startsWith('ps-pane/')) pane.received.push({ topic, data: JSON.parse(text) });
    panes.push(pane);
    return pane;
  };

  const RED = {
    httpAdmin: app,
    settings: { userDir: opts.userDir, ...opts.settings },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    comms: {
      publish(topic: string, data: unknown, retain: boolean) {
        const text = JSON.stringify(data);
        published.push({ topic, data: JSON.parse(text), retain: Boolean(retain) });
        if (retain) retained.set(topic, text); else retained.delete(topic);
        for (const pane of panes) pane.received.push({ topic, data: JSON.parse(text) });
      },
    },
    auth: {
      needsPermission: (permission: string) => (req: any, _res: any, next: () => void) => {
        permissions.set(`${req.method} ${req.path}`, permission);
        next();
      },
    },
  };

  let server: Server | null = null;
  return {
    RED,
    published,
    permissions,
    pane: newPane,
    retained: (topic: string) => (retained.has(topic) ? JSON.parse(retained.get(topic)!) : undefined),
    async listen(): Promise<string> {
      server = await new Promise<Server>((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async close(): Promise<void> {
      if (server) await new Promise<void>((done) => server!.close(() => done()));
    },
  };
}

export function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; order: number }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn, order: id });
      return id;
    },
    clearTimeout(handle: unknown): void { timers.delete(handle as number); },
    /** Move the time on by `ms`, running each timer that falls due, earliest first. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void; order: number }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at || (entry[1].at === due[1].at && entry[1].order < due[1].order))) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
