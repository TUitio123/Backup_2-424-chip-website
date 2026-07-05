/**
 * useChipStatuses
 *
 * Leitet den Status jedes Chips aus den Nostr-Events ab.
 *
 * Logik:
 * - Kind-3492 mit chipStatus="invalid" → Chip ist "entwertenbeantragt" oder "invalid"
 * - Kind-3493 (Zahlung bestätigt) → Chip wurde ausgezahlt → Status "invalid" (fertig entwertet)
 * - Kind-3491 (Aufladen) + bezahlt (localStorage paidChips) → "valid"
 * - Default: "valid" (neu ausgegebener Chip)
 *
 * Die Website zeigt immer den realen Status:
 * - Chip-Status in chipRegistry.ts ist nur der Fallback/Initialwert
 * - Dieser Hook überschreibt ihn mit dem dynamisch ermittelten Status
 */

import { useMemo } from 'react';
import type { ChipStatus } from '@/lib/chipRegistry';
import type { InvalidateRequestEvent } from './useInvalidateRequests';

export interface ChipStatusMap {
  [uid: string]: ChipStatus;
}

/**
 * Berechnet den aktuellen Status jedes Chips aus:
 * - invalidateRequests: Kind-3492-Events (Entwertungs-Anfragen mit invoice)
 * - payoutDone: Set von UIDs die bereits ausgezahlt wurden (aus persistentem Store)
 * - paidChips: UIDs die aktuell aufgeladen sind (localStorage)
 */
export function useChipStatuses(
  invalidateRequests: InvalidateRequestEvent[],
  payoutDone: Set<string>,           // UIDs die ausgezahlt + dauerhaft invalid gespeichert sind
  paidChips: Record<string, string>, // UIDs die in dieser Session aufgeladen wurden
): ChipStatusMap {
  return useMemo(() => {
    const map: ChipStatusMap = {};

    // Alle UIDs mit Entwertungs-Anfragen
    for (const req of invalidateRequests) {
      const uid = req.uid.toUpperCase().replace(/[:\s\-]/g, '');
      if (!uid) continue;

      if (payoutDone.has(uid)) {
        // Ausgezahlt + bestätigt → endgültig invalid
        map[uid] = 'invalid';
      } else if (req.chipStatus === 'invalid') {
        // Anfrage läuft → beantragt
        map[uid] = 'entwertenbeantragt';
      }
    }

    // Aufgeladene Chips überschreiben alles mit "valid"
    // (erst nach erneutem Aufladen darf ein invalid-Chip wieder valid werden)
    for (const uid of Object.keys(paidChips)) {
      const normUID = uid.toUpperCase().replace(/[:\s\-]/g, '');
      // Nur wenn kein payoutDone → gelöschter paid-Eintrag signalisiert Entwertung
      if (!payoutDone.has(normUID)) {
        map[normUID] = 'valid';
      }
    }

    return map;
  }, [invalidateRequests, payoutDone, paidChips]);
}
