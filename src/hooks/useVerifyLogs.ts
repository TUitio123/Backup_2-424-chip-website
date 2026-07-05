import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import { KIND_VERIFY_LOG, APP_TAG } from '@/lib/chipRegistry';

export interface VerifyLogEvent {
  id: string;
  uid: string;
  label: string;
  sats: number;
  tamperStatus: string;
  result: 'verified' | 'warn' | 'unknown';
  timestamp: number; // unix seconds
  pubkey: string;
}

export function useVerifyLogs() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['verify-logs'],
    queryFn: async (c) => {
      const events = await nostr.query(
        [{ kinds: [KIND_VERIFY_LOG], '#t': [APP_TAG], limit: 100 }],
        { signal: c.signal },
      );

      return events
        .map((e): VerifyLogEvent | null => {
          try {
            const data = JSON.parse(e.content) as Record<string, unknown>;
            return {
              id: e.id,
              uid: String(data.uid ?? ''),
              label: String(data.label ?? ''),
              sats: Number(data.sats ?? 0),
              tamperStatus: String(data.tamperStatus ?? ''),
              result: (data.result as VerifyLogEvent['result']) ?? 'unknown',
              timestamp: e.created_at,
              pubkey: e.pubkey,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is VerifyLogEvent => e !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    refetchInterval: 1_000,
  });
}
