export type ChipStatus = 'valid' | 'invalid' | 'entwertenbeantragt';

export interface ChipEntry {
  uid: string;
  label: string;
  sats: number;
  status: ChipStatus;
  info?: string;
  issuedAt?: string;
}

export const CHIP_REGISTRY: ChipEntry[] = [
  { uid: '04A3695ABF1D90', label: '1.500 sats', sats: 1500, status: 'invalid', issuedAt: '05.07.2026' },
  { uid: '0494695ABF1D90', label: '1.400 sats', sats: 1400, status: 'invalid', issuedAt: '05.07.2026' },
  { uid: '0492695ABF1D90', label: '1.300 sats', sats: 1300, status: 'invalid', issuedAt: '05.07.2026' },
  { uid: '04A4695ABF1D90', label: '1.200 sats', sats: 1200, status: 'invalid', issuedAt: '05.07.2026' },
  { uid: '0495695ABF1D90', label: '1.100 sats', sats: 1100, status: 'invalid', issuedAt: '05.07.2026' },
];

export function normalizeUID(uid: string): string {
  return uid.replace(/[:\s\-]/g, '').toUpperCase();
}

export function lookupChip(uid: string): ChipEntry | null {
  const needle = normalizeUID(uid);
  return CHIP_REGISTRY.find(e => normalizeUID(e.uid) === needle) ?? null;
}

/** Kind 6129 – Online Verify Log */
export const KIND_VERIFY_LOG = 6129;

/** Kind 3491 – Aufladen-Anfrage (App → Relay) */
export const KIND_RELOAD_REQUEST = 3491;

/** Kind 3492 – Entwertungs-Anfrage (App → Relay) */
export const KIND_INVALIDATE_REQUEST = 3492;

/** Kind 3493 – Zahlung bestätigt (Website → Relay → App liest) */
export const KIND_PAYMENT_CONFIRMED = 3493;

/** Shared app-tag for relay filtering */
export const APP_TAG = 'bitcoin-note-verifier';
