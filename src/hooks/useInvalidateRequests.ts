/**
 * useInvalidateRequests
 *
 * Liest Nostr Kind-3492-Events (Entwertungs-Anfragen mit Lightning-Invoice).
 * Die Website verarbeitet diese Events: prüft ob Chip-Status "invalid" ist,
 * prüft den Betrag, zahlt via LNbits Admin-Key aus, bestätigt via Kind-3493.
 */

import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { KIND_INVALIDATE_REQUEST, APP_TAG } from '@/lib/chipRegistry';

export interface InvalidateRequestEvent {
  id: string;
  uid: string;
  label: string;
  sats: number;
  invoice: string;        // BOLT11 or Lightning address
  chipStatus: string;     // should be "invalid"
  timestamp: number;
  pubkey: string;
}

export function useInvalidateRequests() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['invalidate-requests'],
    queryFn: async (c) => {
      const events = await nostr.query(
        [{ kinds: [KIND_INVALIDATE_REQUEST], '#t': [APP_TAG], limit: 200 }],
        { signal: c.signal },
      );

      return events
        .map((e): InvalidateRequestEvent | null => {
          try {
            const data = JSON.parse(e.content) as Record<string, unknown>;
            const invoice = String(data.invoice ?? '').trim();
            if (!invoice) return null; // old-style events without invoice
            return {
              id: e.id,
              uid: String(data.uid ?? ''),
              label: String(data.label ?? ''),
              sats: Number(data.sats ?? 0),
              invoice,
              chipStatus: String(data.chipStatus ?? ''),
              timestamp: e.created_at,
              pubkey: e.pubkey,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is InvalidateRequestEvent => e !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    refetchInterval: 8_000,
  });
}

/**
 * Gibt für eine gegebene UID die neueste Invalidierungs-Anfrage zurück.
 * Nur solche mit chipStatus === 'invalid' sind relevant für die Auszahlung.
 */
export function latestInvalidateRequest(
  requests: InvalidateRequestEvent[],
  uid: string,
): InvalidateRequestEvent | null {
  const normalizedUID = uid.toUpperCase().replace(/[:\s\-]/g, '');
  return (
    requests.find(r =>
      r.uid.toUpperCase().replace(/[:\s\-]/g, '') === normalizedUID &&
      r.chipStatus === 'invalid' &&
      r.invoice.length > 0,
    ) ?? null
  );
}
