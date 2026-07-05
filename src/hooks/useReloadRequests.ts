/**
 * useReloadRequests
 *
 * Liest Nostr Kind-3491-Events (Aufladen-Anfragen) von der App.
 * Die Website zeigt den Aufladen-Button NUR wenn eine solche Anfrage existiert.
 */

import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { KIND_RELOAD_REQUEST, APP_TAG } from '@/lib/chipRegistry';

export interface ReloadRequestEvent {
  id: string;
  uid: string;
  label: string;
  sats: number;
  timestamp: number; // unix seconds
  pubkey: string;
}

export function useReloadRequests() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['reload-requests'],
    queryFn: async (c) => {
      const events = await nostr.query(
        [{ kinds: [KIND_RELOAD_REQUEST], '#t': [APP_TAG], limit: 200 }],
        { signal: c.signal },
      );

      return events
        .map((e): ReloadRequestEvent | null => {
          try {
            const data = JSON.parse(e.content) as Record<string, unknown>;
            return {
              id: e.id,
              uid: String(data.uid ?? ''),
              label: String(data.label ?? ''),
              sats: Number(data.sats ?? 0),
              timestamp: e.created_at,
              pubkey: e.pubkey,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is ReloadRequestEvent => e !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    refetchInterval: 1_000,
  });
}

/**
 * Gibt für eine gegebene UID den neuesten Reload-Request zurück,
 * oder null wenn keiner vorhanden.
 */
export function latestReloadRequest(
  requests: ReloadRequestEvent[],
  uid: string,
): ReloadRequestEvent | null {
  const normalizedUID = uid.toUpperCase();
  return (
    requests.find(r => r.uid.toUpperCase() === normalizedUID) ?? null
  );
}
