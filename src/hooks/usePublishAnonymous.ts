/**
 * usePublishAnonymous
 *
 * Publishes a Nostr event signed by a fixed ephemeral app keypair.
 * No user login required. Used for website actions like "Entwerten"
 * where the website itself sends the signal.
 *
 * The keypair is deterministic and hardcoded — it is NOT a user identity,
 * just a shared app-level signing key so that events are validly signed.
 */

import { useMutation } from '@tanstack/react-query';
import { finalizeEvent } from 'nostr-tools';
import type { EventTemplate } from 'nostr-tools';

// Fixed ephemeral app keypair — generated once, embedded here.
// This is intentionally public: it has no funds and no identity value.
const APP_SECRET_KEY = new Uint8Array([
  0x7a, 0x3f, 0x12, 0xc8, 0x4e, 0x91, 0xb5, 0x6d,
  0x2a, 0x80, 0xf4, 0x37, 0xcc, 0x59, 0x1e, 0x8b,
  0x6f, 0x25, 0xd7, 0x43, 0xa1, 0x9c, 0x70, 0xe6,
  0x58, 0x14, 0xb3, 0x2f, 0x91, 0x6a, 0x47, 0xd2,
]);

const RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
];

async function publishToRelay(relayUrl: string, event: ReturnType<typeof finalizeEvent>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout: ${relayUrl}`));
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data as string) as unknown[];
        if (Array.isArray(data) && data[0] === 'OK') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${relayUrl}`));
    };
  });
}

type PartialTemplate = Pick<EventTemplate, 'kind' | 'content'> &
  Partial<Pick<EventTemplate, 'tags' | 'created_at'>>;

export function usePublishAnonymous() {
  return useMutation({
    mutationFn: async (t: PartialTemplate) => {
      const template: EventTemplate = {
        kind: t.kind,
        content: t.content ?? '',
        tags: t.tags ?? [],
        created_at: t.created_at ?? Math.floor(Date.now() / 1000),
      };

      const event = finalizeEvent(template, APP_SECRET_KEY);

      // Publish to all relays, ignore individual failures
      const results = await Promise.allSettled(
        RELAYS.map(url => publishToRelay(url, event)),
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      if (succeeded === 0) {
        throw new Error('Kein Relay erreichbar. Bitte Internetverbindung prüfen.');
      }

      return event;
    },
  });
}
