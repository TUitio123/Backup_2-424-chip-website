/**
 * LNbits Configuration
 *
 * Um die Credentials zu wechseln: NUR diese Datei bearbeiten.
 * Alle anderen Dateien importieren ausschließlich von hier.
 *
 * Testaccount: https://demo.lnbits.com
 * Wallet ID:   0bf074dd4eff4b8aa6ce1facb923fd45
 */

export const LNBITS_CONFIG = {
  /** Base URL des LNbits-Servers, ohne abschließenden Slash */
  nodeUrl: 'https://demo.lnbits.com',

  /** Wallet ID */
  walletId: '0bf074dd4eff4b8aa6ce1facb923fd45',

  /**
   * Invoice/Read Key — wird für das Erstellen von Eingangs-Invoices benötigt.
   * Nur lesend / invoice-erstellend. Kein Abheben möglich.
   */
  invoiceReadKey: 'eb1c24f76be349ac8fcc2ef8d6df7fa9',

  /**
   * Admin Key — nur verwenden wenn nötig (z.B. Auszahlungen).
   * Im normalen Betrieb wird nur invoiceReadKey benötigt.
   */
  adminKey: '56724571b2714044b7602bfe26c2eb62',

  /** Invoice-Ablaufzeit in Sekunden (Standard: 1 Stunde = 3600) */
  invoiceExpiry: 3600,

  /**
   * Aufpreis-Prozentsatz beim Aufladen (1% des Chip-Guthabens, mind. 1 sat).
   * z.B. 2.100 sats → Gebühr = 21 sats → Invoice = 2.121 sats
   */
  reloadFeePercent: 0.01,
} as const;

/** Berechnet die Gebühr: 1% des Chip-Betrags, mind. 1 sat */
export function calcReloadFee(sats: number): number {
  return Math.max(1, Math.round(sats * LNBITS_CONFIG.reloadFeePercent));
}
