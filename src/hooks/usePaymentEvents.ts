/**
 * usePaymentEvents
 *
 * Liest ALLE Kind-3493 Events (Zahlungsbestaetigungen) von Nostr.
 * Daraus wird der permanente Chip-Status abgeleitet:
 *
 *   type:"reload"  → Chip wurde aufgeladen → Status "valid"
 *   type:"payout"  → Chip wurde ausgezahlt → Status "invalid"
 *
 * Die NEUESTE Bestätigung pro Chip gewinnt.
 * Das ist die einzige Wahrheitsquelle (Single Source of Truth).
 * localStorage wird nur noch als Cache/Fallback verwendet.
 */

import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { KIND_PAYMENT_CONFIRMED, APP_TAG, normalizeUID } from '@/lib/chipRegistry';

export interface PaymentEvent {
  id: string;
  uid: string;
  type: 'reload' | 'payout';
  paymentHash: string;
  paidAt: string;
  sats: number;
  timestamp: number;
}

export function usePaymentEvents() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['payment-events'],
    queryFn: async (c) => {
      const events = await nostr.query(
        [{ kinds: [KIND_PAYMENT_CONFIRMED], '#t': [APP_TAG], limit: 500 }],
        { signal: c.signal },
      );

      return events
        .map((e): PaymentEvent | null => {
          try {
            const data = JSON.parse(e.content) as Record<string, unknown>;
            const type = String(data.type ?? '');
            if (type !== 'reload' && type !== 'payout') return null;
            return {
              id: e.id,
              uid: String(data.uid ?? ''),
              type: type as 'reload' | 'payout',
              paymentHash: String(data.paymentHash ?? ''),
              paidAt: String(data.paidAt ?? ''),
              sats: Number(data.sats ?? 0),
              timestamp: e.created_at,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is PaymentEvent => e !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    refetchInterval: 1_000,
  });
}

/**
 * Neuestes reload UND neuestes payout Event fuer eine UID.
 * Vergleicht beide Timestamps — das neuere gewinnt.
 */
export function latestPaymentForChip(
  events: PaymentEvent[],
  uid: string,
): PaymentEvent | null {
  const norm = normalizeUID(uid);
  const matching = events.filter(e => normalizeUID(e.uid) === norm);
  const latestReload = matching.find(e => e.type === 'reload') ?? null;
  const latestPayout = matching.find(e => e.type === 'payout') ?? null;

  if (latestReload && latestPayout) {
    // Beide existieren → das neuere gewinnt
    return latestReload.timestamp >= latestPayout.timestamp ? latestReload : latestPayout;
  }
  return latestReload ?? latestPayout;
}
