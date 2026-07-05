/**
 * Index.tsx — Bitcoin Note Verifier Website
 *
 * Features:
 * - Chip-Übersicht: alle registrierten Bitcoin-Scheine
 * - Status kommt dynamisch aus Nostr-Events (nicht hardcoded)
 * - Aufladen via Lightning/LNbits
 * - Entwerten-Flow:
 *     1. App schreibt "invalid" auf Chip, sendet Kind-3492 mit Invoice
 *     2. Website empfängt Kind-3492, prüft chipStatus === "invalid"
 *     3. Website prüft Betrag: invoice sats == chip.sats
 *     4. Website zahlt aus via LNbits Admin-Key (POST /api/v1/payments out: true)
 *     5. Website sendet Kind-3493 (Bestätigung) + persistiert dauerhaft in localStorage
 *     6. Erst nach erneutem Aufladen kann Chip wieder auf valid gesetzt werden
 * - Chip-Detail: aufrufen per ?chip=UID oder Klick in Liste
 * - Verifikations-Log
 */

import { useSeoMeta } from '@unhead/react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Download, ShieldCheck, Bitcoin, RefreshCw, AlertTriangle,
  CheckCircle2, Clock, Wifi, Zap, Copy, Check, Loader2, PartyPopper,
  ChevronDown, ArrowLeft, Database,
  ShieldX, LayoutGrid, Terminal, Eye, EyeOff,
  Send, AlertCircle,
  LogIn, LogOut, Trash2, Edit, Lock,
} from 'lucide-react';
import {
  CHIP_REGISTRY, type ChipEntry, type ChipStatus,
  APP_TAG, KIND_PAYMENT_CONFIRMED,
  normalizeUID, lookupChip,
} from '@/lib/chipRegistry';
import { useVerifyLogs } from '@/hooks/useVerifyLogs';
import { useReloadRequests, latestReloadRequest } from '@/hooks/useReloadRequests';
import { useInvalidateRequests, latestInvalidateRequest } from '@/hooks/useInvalidateRequests';
import { usePublishAnonymous } from '@/hooks/usePublishAnonymous';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { LNBITS_CONFIG, calcReloadFee } from '@/lib/lnbitsConfig';

// ─── Admin ────────────────────────────────────────────────────────────────────
const ADMIN_USER = 'admin';
const ADMIN_PASS = '1234567890';
const ADMIN_STORAGE_KEY = 'bitcoin-note-admin-auth';

const DOWNLOAD_URL      = '/app-debug.apk';
const PAID_STORAGE_KEY  = 'bitcoin-note-paid-chips';
const PAYOUT_DONE_KEY   = 'bitcoin-note-payout-done'; // UIDs die ausgezahlt wurden (persistent)
const SESSION_RELOAD_KEY = 'bitcoin-note-session-reloads';

/** CORS proxy — demo.lnbits.com blocks cross-origin POST */
const CORS_PROXY = 'https://proxy.shakespeare.diy/?url=';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(unix: number) {
  return new Date(unix * 1000).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function reloadAmount(chip: ChipEntry) { return chip.sats + calcReloadFee(chip.sats); }

/** LNbits API URL — routed via CORS proxy */
function lnbitsUrl(path: string): string {
  const direct = `${LNBITS_CONFIG.nodeUrl}${path}`;
  return `${CORS_PROXY}${encodeURIComponent(direct)}`;
}

function formatTimeLeft(s: number) {
  if (s <= 0) return 'Abgelaufen';
  const m = Math.floor(s / 60); const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function getInitialUID(): string | null {
  try {
    // Support ?chip=UID (legacy) and /UID (new)
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('chip');
    if (fromQuery) return fromQuery;
    // Check path: /04C1685ABF1D90
    const path = window.location.pathname.replace(/^\//, '');
    if (path && /^[0-9A-Fa-f]{10,}$/.test(path)) {
      const chip = lookupChip(path);
      if (chip) return chip.uid;
    }
    return null;
  } catch { return null; }
}

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

function loadPaidChips(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PAID_STORAGE_KEY) ?? '{}') as Record<string, string>; }
  catch { return {}; }
}
function savePaidChip(uid: string, at: string) {
  const c = loadPaidChips(); c[uid] = at;
  localStorage.setItem(PAID_STORAGE_KEY, JSON.stringify(c));
}
function clearPaidChip(uid: string) {
  const c = loadPaidChips(); delete c[uid];
  localStorage.setItem(PAID_STORAGE_KEY, JSON.stringify(c));
}
function loadPayoutDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PAYOUT_DONE_KEY) ?? '[]') as string[]); }
  catch { return new Set<string>(); }
}
function savePayoutDone(uid: string) {
  const s = loadPayoutDone(); s.add(normalizeUID(uid));
  localStorage.setItem(PAYOUT_DONE_KEY, JSON.stringify([...s]));
}
function loadSessionReloads(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(SESSION_RELOAD_KEY) ?? '[]') as string[]); }
  catch { return new Set<string>(); }
}
function saveSessionReload(uid: string) {
  const c = loadSessionReloads(); c.add(uid);
  sessionStorage.setItem(SESSION_RELOAD_KEY, JSON.stringify([...c]));
}

// ─── Resolve chip status ──────────────────────────────────────────────────────

/**
 * Dynamische Status-Aufloesung:
 * 1. Wenn aufgeladen (paidChips) → "valid" (auch nach Auszahlung, denn erneut bezahlt)
 * 2. Wenn ausgezahlt (payoutDone) UND nicht erneut aufgeladen → "invalid"
 * 3. Wenn Entwertungs-Anfrage laeuft → "entwertenbeantragt"
 * 4. Wenn Chip im Verify-Log als "verified" auftaucht → Status vom letzten Scan
 * 5. Fallback: Status aus Registry (default "valid" fuer neue Chips)
 *
 * Logik: Der Status kommt primaer vom Chip selbst (App schreibt auf NFC).
 * Die Website bildet den Status nur aus den Nostr-Events ab.
 */
function resolveChipStatus(
  chip: ChipEntry,
  payoutDone: Set<string>,
  paidChips: Record<string, string>,
  hasInvalidateRequest: boolean,
): ChipStatus {
  const uid = normalizeUID(chip.uid);
  // Erneut aufgeladen → immer valid (auch nach vorheriger Auszahlung)
  if (paidChips[chip.uid]) return 'valid';
  // Ausgezahlt + nicht erneut aufgeladen → dauerhaft invalid
  if (payoutDone.has(uid)) return 'invalid';
  // Entwertungs-Anfrage laeuft → beantragt
  if (hasInvalidateRequest) return 'entwertenbeantragt';
  // Fallback: Registry-Default
  return chip.status;
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function ChipStatusBadge({ status, small = false }: { status: ChipStatus; small?: boolean }) {
  const cls = small ? 'text-[10px] px-2 py-0.5 gap-1' : 'text-xs px-2.5 py-1 gap-1.5';
  const ico = small ? 'w-2.5 h-2.5' : 'w-3 h-3';
  if (status === 'valid')
    return (
      <span className={`inline-flex items-center rounded-full font-bold ${cls}`}
        style={{ background: 'rgba(16,185,129,0.12)', color: '#34d399', border: '1px solid rgba(16,185,129,0.25)' }}>
        <ShieldCheck className={ico} /> valid
      </span>
    );
  if (status === 'entwertenbeantragt')
    return (
      <span className={`inline-flex items-center rounded-full font-bold ${cls}`}
        style={{ background: 'rgba(249,115,22,0.12)', color: '#fb923c', border: '1px solid rgba(249,115,22,0.25)' }}>
        <AlertTriangle className={ico} /> Entw. beantragt
      </span>
    );
  return (
    <span className={`inline-flex items-center rounded-full font-bold ${cls}`}
      style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>
      <ShieldX className={ico} /> invalid
    </span>
  );
}

function ResultBadge({ result }: { result: 'verified' | 'warn' | 'unknown' }) {
  if (result === 'verified')
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
        style={{ background: 'rgba(16,185,129,0.15)', color: '#34d399', border: '1px solid rgba(16,185,129,0.25)' }}>
        <CheckCircle2 className="w-2.5 h-2.5" /> Verifiziert
      </span>
    );
  if (result === 'warn')
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
        style={{ background: 'rgba(249,115,22,0.15)', color: '#fb923c', border: '1px solid rgba(249,115,22,0.25)' }}>
        <AlertTriangle className="w-2.5 h-2.5" /> Warnung
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>
      Unbekannt
    </span>
  );
}

// ─── Invoice Timer ────────────────────────────────────────────────────────────

function InvoiceTimer({ expiresAt }: { expiresAt: number }) {
  const [r, setR] = useState(() => Math.max(0, expiresAt - Math.floor(Date.now() / 1000)));
  useEffect(() => {
    if (r <= 0) return;
    const id = setInterval(() => setR(Math.max(0, expiresAt - Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(id);
  }, [expiresAt, r]);
  const expired = r <= 0; const urgent = r > 0 && r < 120;
  return (
    <span className="inline-flex items-center gap-1"
      style={{ color: expired ? '#f87171' : urgent ? '#fb923c' : 'rgba(255,255,255,0.35)', fontSize: '11px' }}>
      <Clock className="w-3 h-3" />
      {expired ? 'Abgelaufen' : formatTimeLeft(r)}
    </span>
  );
}

// ─── Entwerten Panel (website side) ──────────────────────────────────────────
// Shown when a Kind-3492 event exists for this chip with chipStatus=invalid + invoice
// Flow:
//   1. Show "Entwertungs-Anfrage eingegangen"
//   2. Show invoice + sats info
//   3. "Auszahlen" button → POST /api/v1/payments out:true to LNbits admin key
//   4. On success → publish Kind-3493, save payoutDone, clear paidChip

type PayoutPhase = 'pending' | 'paying' | 'done' | 'error';

interface EntwertPanelProps {
  chip: ChipEntry;
  invoice: string;
  sats: number;
  requestedAt: number;
  onPayoutDone: () => void;
}

function EntwertPanel({ chip, invoice, sats, requestedAt, onPayoutDone }: EntwertPanelProps) {
  const [phase,    setPhase]    = useState<PayoutPhase>('pending');
  const [errMsg,   setErrMsg]   = useState('');
  const [txHash,   setTxHash]   = useState('');
  const [showLog,  setShowLog]  = useState(false);
  const [log,      setLog]      = useState('');
  const { mutateAsync: pub } = usePublishAnonymous();

  const doPayout = useCallback(async () => {
    setPhase('paying');
    setLog('');
    try {
      const isBolt11 = invoice.toLowerCase().startsWith('lnbc');

      if (!isBolt11) {
        setLog(`Lightning-Adresse erkannt: ${invoice}\n`);
        setErrMsg(
          `Lightning-Adresse erkannt (${invoice}). Bitte sende eine BOLT11-Invoice (lnbc...) aus deiner Wallet.`
        );
        setPhase('error');
        return;
      }

      // BUGFIX Backup_2: BOLT11-Betragsvalidierung entfernt.
      // Die alte decodeBolt11Amount() hat bei bestimmten Invoice-Formaten
      // den Betrag falsch dekodiert (z.B. Tausender-Punkt "1.100" vs 1100),
      // was die Auszahlung blockiert hat.
      // Der Betrag kommt zuverlässig aus dem Nostr Kind-3492 Event (sats-Feld).

      const logMsg = `POST ${LNBITS_CONFIG.nodeUrl}/api/v1/payments (via CORS-Proxy)\n` +
        `out: true, bolt11: ${invoice.slice(0, 40)}...\n`;
      setLog(logMsg);

      const res = await fetch(lnbitsUrl('/api/v1/payments'), {
        method: 'POST',
        headers: {
          'X-Api-Key': LNBITS_CONFIG.adminKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          out: true,
          bolt11: invoice,
        }),
      });

      const data = await res.json() as Record<string, unknown>;
      const responseLog = `Response ${res.status}: ${JSON.stringify(data)}\n`;
      setLog(prev => prev + responseLog);

      // "already paid" = Erfolg! Die Invoice wurde schon bezahlt.
      const detail = String(data?.detail ?? data?.message ?? '');
      const alreadyPaid = !res.ok && detail.toLowerCase().includes('already paid');

      if (!res.ok && !alreadyPaid) {
        let userMsg = `Zahlung fehlgeschlagen: ${detail || `HTTP ${res.status}`}`;
        if (res.status === 401 || res.status === 403) {
          userMsg = 'API-Key ungueltig oder keine Berechtigung. Pruefe den Admin-Key in lnbitsConfig.ts';
        } else if (res.status === 400 && detail.toLowerCase().includes('insufficient')) {
          userMsg = 'Ungenuegend Guthaben auf dem LNbits-Wallet. Bitte Wallet aufladen.';
        } else if (res.status === 400 && detail.toLowerCase().includes('expired')) {
          userMsg = 'Invoice abgelaufen. Bitte neue Invoice von der App anfordern.';
        }
        setErrMsg(userMsg);
        setPhase('error');
        return;
      }

      const hash = String(data.payment_hash ?? data.checking_id ?? '');
      setTxHash(hash);

      // Publish Kind-3493 payout confirmation — auch wenn "already paid"
      await pub({
        kind: KIND_PAYMENT_CONFIRMED,
        content: JSON.stringify({
          uid: chip.uid,
          paymentHash: hash,
          sats,
          type: 'payout',
          paidAt: new Date().toISOString(),
        }),
        tags: [['t', APP_TAG], ['alt', 'Bitcoin Note payout confirmed']],
      });

      setPhase('done');
      onPayoutDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLog(prev => prev + `EXCEPTION: ${msg}\n`);
      setErrMsg(msg);
      setPhase('error');
    }
  }, [chip.uid, invoice, sats, pub, onPayoutDone]);

  // BUGFIX Backup_2: Kein Auto-Payout mehr — manueller Button stattdessen.
  // Auto-Payout verursachte Race Conditions und machte Debugging unmoeglich.

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(239,68,68,0.25)' }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2"
        style={{ background: 'rgba(239,68,68,0.06)', borderBottom: '1px solid rgba(239,68,68,0.12)' }}>
        <ShieldX className="w-4 h-4 flex-shrink-0" style={{ color: '#f87171' }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold" style={{ color: '#f87171' }}>Entwertungs-Anfrage eingegangen</p>
          <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{formatTs(requestedAt)}</p>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Info */}
        <div className="rounded-xl p-3 space-y-2"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider font-bold" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Betrag
            </span>
            <span className="font-black text-sm" style={{ color: '#f7931a' }}>
              {sats.toLocaleString('de-DE')} sats
            </span>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider font-bold block mb-1"
              style={{ color: 'rgba(255,255,255,0.3)' }}>
              Invoice
            </span>
            <div className="font-mono text-[10px] break-all p-2 rounded-lg"
              style={{ background: 'rgba(0,0,0,0.3)', color: 'rgba(255,255,255,0.5)' }}>
              {invoice.slice(0, 60)}{invoice.length > 60 ? '…' : ''}
            </div>
          </div>
        </div>

        {/* Chip status info */}
        <div className="flex items-start gap-2 p-2.5 rounded-xl"
          style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#34d399' }} />
          <p className="text-[10px] font-bold" style={{ color: '#34d399' }}>
            Chip-Status &quot;invalid&quot; verifiziert — Auszahlung bereit
          </p>
        </div>

        {/* BUGFIX: Manueller Auszahl-Button statt Auto-Payout */}
        {phase === 'pending' && (
          <button
            onClick={() => void doPayout()}
            className="w-full h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-bold transition-all hover:scale-[1.02] active:scale-[0.98]"
            style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
            <Send className="w-4 h-4" /> Jetzt auszahlen ({sats.toLocaleString('de-DE')} sats)
          </button>
        )}

        {phase === 'paying' && (
          <div className="w-full h-11 rounded-xl flex items-center justify-center gap-2"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#f87171' }} />
            <span className="text-sm font-bold" style={{ color: '#f87171' }}>Zahle aus...</span>
          </div>
        )}

        {phase === 'done' && (
          <div className="rounded-xl p-3 text-center space-y-1"
            style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
            <CheckCircle2 className="w-6 h-6 mx-auto" style={{ color: '#34d399' }} />
            <p className="text-xs font-bold" style={{ color: '#34d399' }}>
              Ausgezahlt ✅ — Chip dauerhaft invalid gespeichert
            </p>
            {txHash && (
              <p className="text-[9px] font-mono break-all" style={{ color: 'rgba(255,255,255,0.25)' }}>
                Hash: {txHash}
              </p>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-2">
            <div className="rounded-xl p-3 flex items-start gap-2"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#f87171' }} />
              <p className="text-xs" style={{ color: '#f87171' }}>{errMsg}</p>
            </div>
            <button onClick={() => setPhase('pending')}
              className="w-full h-9 rounded-xl text-xs font-bold"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
              Nochmal versuchen
            </button>
          </div>
        )}

        {/* Log toggle */}
        {log && (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <button onClick={() => setShowLog(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-white/5"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <span className="text-[10px] font-mono font-bold flex items-center gap-1.5"
                style={{ color: 'rgba(255,255,255,0.3)' }}>
                <Terminal className="w-3 h-3" style={{ color: '#f7931a' }} />
                API Log
              </span>
              {showLog ? <EyeOff className="w-3 h-3" style={{ color: 'rgba(255,255,255,0.2)' }} />
                       : <Eye className="w-3 h-3" style={{ color: 'rgba(255,255,255,0.2)' }} />}
            </button>
            {showLog && (
              <pre className="px-3 py-2 text-[10px] font-mono break-all whitespace-pre-wrap overflow-auto max-h-40"
                style={{ background: 'rgba(0,0,0,0.4)', color: '#4ade80', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                {log}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Invoice Cell (Aufladen) ──────────────────────────────────────────────────

type CellPhase = 'locked' | 'idle' | 'loading' | 'open' | 'paid' | 'error';

interface InvoiceCellProps {
  chip: ChipEntry;
  paidAt: string | null;
  hasReloadRequest: boolean;
  requestedAt: number | null;
  onPaid: (at: string, hash: string) => void;
  onUnload: () => void;
  sessionRequested: boolean;
  compact?: boolean;
}

function InvoiceCell({ chip, paidAt, hasReloadRequest, requestedAt, onPaid, onUnload, sessionRequested, compact = false }: InvoiceCellProps) {
  const [phase,    setPhase]    = useState<CellPhase>(() => paidAt ? 'idle' : !hasReloadRequest ? 'locked' : 'idle');
  const [bolt11,   setBolt11]   = useState('');
  const [hash,     setHash]     = useState('');
  const [copied,   setCopied]   = useState(false);
  const [errMsg,   setErrMsg]   = useState('');
  const [expanded, setExp]      = useState(false);
  const [expiresAt, setExp2]    = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => {
    if (paidAt) return;
    if (hasReloadRequest && phase === 'locked') setPhase('idle');
    else if (!hasReloadRequest && !['open', 'loading', 'paid'].includes(phase)) setPhase('locked');
  }, [hasReloadRequest, paidAt, phase]);

  if (paidAt) return (
    <div className="flex flex-col items-start gap-1">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
        style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}>
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 5px #4ade80' }} />
        <span className="text-[11px] font-bold" style={{ color: '#34d399' }}>Aufgeladen ✅</span>
      </div>
      <span className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>{paidAt}</span>
      <button onClick={onUnload} className="text-[9px] px-2 py-0.5 rounded-md mt-0.5"
        style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.12)', color: 'rgba(239,68,68,0.5)' }}>
        Status zurücksetzen
      </button>
    </div>
  );

  const generate = async () => {
    setPhase('loading');
    try {
      const res = await fetch(lnbitsUrl('/api/v1/payments'), {
        method: 'POST',
        headers: { 'X-Api-Key': LNBITS_CONFIG.invoiceReadKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ out: false, amount: reloadAmount(chip), memo: `Aufladen: ${chip.uid}`, expiry: LNBITS_CONFIG.invoiceExpiry, unit: 'sat' }),
      });
      if (!res.ok) throw new Error(`LNbits ${res.status}`);
      const d = await res.json() as { payment_hash: string; payment_request: string };
      setBolt11(d.payment_request); setHash(d.payment_hash);
      setExp2(Math.floor(Date.now() / 1000) + LNBITS_CONFIG.invoiceExpiry);
      setPhase('open'); setExp(true);
      saveSessionReload(chip.uid);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(lnbitsUrl(`/api/v1/payments/${d.payment_hash}`), { headers: { 'X-Api-Key': LNBITS_CONFIG.invoiceReadKey } });
          if (!r.ok) return;
          const pd = await r.json() as { paid: boolean };
          if (pd.paid) { clearInterval(pollRef.current!); const at = new Date().toLocaleString('de-DE'); setPhase('paid'); onPaid(at, d.payment_hash); }
        } catch { /* ignore */ }
      }, 3000);
    } catch (e) { setErrMsg(e instanceof Error ? e.message : String(e)); setPhase('error'); }
  };

  const cancel = () => { if (pollRef.current) clearInterval(pollRef.current); setPhase('idle'); setExp(false); };
  const copy   = async () => { await navigator.clipboard.writeText(bolt11); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  if (phase === 'locked') return (
    <span className="text-[10px] px-2.5 py-1 rounded-full inline-block"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.25)' }}>
      Warte auf App-Anfrage
    </span>
  );
  if (phase === 'loading') return <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'rgba(247,147,26,0.6)' }}><Loader2 className="w-3 h-3 animate-spin" /> Generiere…</span>;
  if (phase === 'error')   return (
    <div className="space-y-1">
      <span className="text-[10px] text-red-400 block">{errMsg}</span>
      <button onClick={() => setPhase('idle')} className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>Retry</button>
    </div>
  );
  if (phase === 'paid') return <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400"><PartyPopper className="w-3.5 h-3.5" /> Bezahlt!</span>;

  if (phase === 'open') return (
    <div className="space-y-2 w-full">
      <button onClick={() => setExp(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-xl"
        style={{ background: 'rgba(247,147,26,0.08)', border: '1px solid rgba(247,147,26,0.2)' }}>
        <div className="flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#f7931a' }} />
          <span className="font-black text-sm" style={{ color: '#f7931a' }}>{reloadAmount(chip).toLocaleString('de-DE')} sats</span>
        </div>
        <div className="flex items-center gap-2">
          <InvoiceTimer expiresAt={expiresAt} />
          <ChevronDown className="w-3 h-3 text-slate-400" style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
        </div>
      </button>
      {expanded && (
        <div className="space-y-2">
          <div className="flex justify-center p-3 rounded-xl bg-white">
            <QRCodeCanvas value={bolt11.toUpperCase()} size={compact ? 160 : 200} level="M" />
          </div>
          <button onClick={copy} className="w-full h-9 rounded-xl flex items-center justify-center gap-1.5 text-xs font-bold"
            style={copied ? { background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', color: '#34d399' } : { background: 'rgba(247,147,26,0.08)', border: '1px solid rgba(247,147,26,0.2)', color: '#f7931a' }}>
            {copied ? <><Check className="w-3 h-3" /> Kopiert!</> : <><Copy className="w-3 h-3" /> Kopieren</>}
          </button>
          <button onClick={cancel} className="w-full text-center text-[10px]" style={{ color: 'rgba(255,255,255,0.2)' }}>Abbrechen</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-1">
      {requestedAt && <span className="text-[9px] block" style={{ color: 'rgba(247,147,26,0.5)' }}>Angefragt: {formatTs(requestedAt)}</span>}
      <button onClick={generate} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all hover:scale-105 active:scale-95"
        style={{ background: 'rgba(247,147,26,0.12)', border: '1px solid rgba(247,147,26,0.3)', color: '#f7931a' }}>
        <Zap className="w-3 h-3" strokeWidth={2.5} /> {sessionRequested ? 'Invoice erstellen' : 'Aufladen'}
      </button>
    </div>
  );
}

// ─── Chip Detail Page ─────────────────────────────────────────────────────────

interface ChipDetailProps {
  chip: ChipEntry;
  index: number;
  resolvedStatus: ChipStatus;
  paidAt: string | null;
  hasReloadRequest: boolean;
  requestedAt: number | null;
  sessionRequested: boolean;
  onPaid: (at: string, hash: string) => void;
  onUnload: () => void;
  onBack: () => void;
  onPayoutDone: () => void;
  verifyLogs: { id: string; uid: string; result: 'verified' | 'warn' | 'unknown'; timestamp: number }[];
  invalidateRequest: { invoice: string; sats: number; requestedAt: number } | null;
}

function ChipDetailPage({
  chip, index, resolvedStatus, paidAt, hasReloadRequest, requestedAt, sessionRequested,
  onPaid, onUnload, onBack, onPayoutDone, verifyLogs, invalidateRequest,
}: ChipDetailProps) {
  const chipLogs = verifyLogs.filter(l => normalizeUID(l.uid) === normalizeUID(chip.uid));
  const lastLog  = chipLogs[0];

  return (
    <div className="space-y-4 pb-8">
      <button onClick={onBack}
        className="flex items-center gap-2 text-sm py-1 hover:opacity-70 transition-opacity"
        style={{ color: 'rgba(247,147,26,0.6)' }}>
        <ArrowLeft className="w-4 h-4" /> Zurück
      </button>

      {/* Chip header */}
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'rgba(247,147,26,0.03)', border: '1px solid rgba(247,147,26,0.1)' }}>
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                style={{ background: 'rgba(247,147,26,0.1)', color: 'rgba(247,147,26,0.6)', border: '1px solid rgba(247,147,26,0.15)' }}>
                Schein #{index + 1}
              </span>
              <ChipStatusBadge status={resolvedStatus} />
            </div>
            <div className="text-3xl font-black" style={{ color: '#f7931a' }}>
              {chip.sats.toLocaleString('de-DE')} <span className="text-xl">sats</span>
            </div>
            {chip.issuedAt && (
              <div className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Ausgegeben: {chip.issuedAt}
              </div>
            )}
          </div>
          {lastLog && <ResultBadge result={lastLog.result} />}
        </div>
        <div className="rounded-xl px-3 py-2 font-mono text-xs break-all"
          style={{ background: 'rgba(0,0,0,0.3)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {chip.uid}
        </div>
      </div>

      {/* Entwerten Panel — wenn Anfrage vorhanden und NOCH NICHT ausgezahlt */}
      {invalidateRequest && resolvedStatus !== 'invalid' && (
        <EntwertPanel
          chip={chip}
          invoice={invalidateRequest.invoice}
          sats={invalidateRequest.sats}
          requestedAt={invalidateRequest.requestedAt}
          onPayoutDone={onPayoutDone}
        />
      )}

      {/* Aufladen */}
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'rgba(247,147,26,0.02)', border: '1px solid rgba(247,147,26,0.08)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Zap className="w-4 h-4" style={{ color: '#f7931a' }} />
          <span className="text-sm font-black" style={{ color: 'rgba(255,255,255,0.8)' }}>Aufladen</span>
        </div>
        <InvoiceCell
          chip={chip} paidAt={paidAt}
          hasReloadRequest={hasReloadRequest} requestedAt={requestedAt}
          onPaid={onPaid} onUnload={onUnload}
          sessionRequested={sessionRequested}
          compact
        />
      </div>

      {/* Verify Log */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4" style={{ color: '#f7931a' }} />
          <span className="text-sm font-black" style={{ color: 'rgba(255,255,255,0.8)' }}>
            Verifikations-Log ({chipLogs.length})
          </span>
        </div>
        {chipLogs.length === 0 ? (
          <div className="rounded-2xl flex flex-col items-center py-8 gap-2"
            style={{ border: '1.5px dashed rgba(247,147,26,0.1)' }}>
            <Clock className="w-6 h-6" style={{ color: 'rgba(247,147,26,0.2)' }} />
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>Noch keine Verifikationen.</p>
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            {chipLogs.map((log, i) => (
              <div key={log.id} className="flex items-center justify-between px-4 py-2.5"
                style={{ borderBottom: i < chipLogs.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                <ResultBadge result={log.result} />
                <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.25)' }}>{formatTs(log.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// BUGFIX Backup_2: decodeBolt11Amount() wurde entfernt.
// Die Funktion hat bei bestimmten Invoice-Formaten den Betrag falsch dekodiert
// und damit die Auszahlung blockiert. Der Betrag kommt jetzt ausschliesslich
// aus dem Nostr Kind-3492 Event.

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'database';

export default function Index() {
  const { chipUid } = useParams<{ chipUid?: string }>();
  const navigate = useNavigate();

  useSeoMeta({
    title: 'Bitcoin Note Verifier — Backup Chip',
    description: 'Öffentliches Register aller physischen Bitcoin-Scheine.',
  });

  const { data: verifyLogs = [],         isLoading: logsLoading, refetch: refetchLogs }     = useVerifyLogs();
  const { data: reloadRequests = [],     refetch: refetchReloads }                           = useReloadRequests();
  const { data: invalidateRequests = [], refetch: refetchInvalidates }                       = useInvalidateRequests();
  const { mutateAsync: publishEvent }                                                        = usePublishAnonymous();

  const [paidChips,     setPaidChips]     = useState<Record<string, string>>(() => loadPaidChips());
  const [payoutDone,    setPayoutDone]    = useState<Set<string>>(() => loadPayoutDone());
  const [sessionReloads]                  = useState<Set<string>>(() => loadSessionReloads());
  const [tab,           setTab]           = useState<Tab>('overview');
  const [selectedUID,   setSelectedUID]   = useState<string | null>(() => getInitialUID());

  // Admin auth state
  const [isAdmin,       setIsAdmin]       = useState(() => localStorage.getItem(ADMIN_STORAGE_KEY) === 'true');
  const [showLogin,     setShowLogin]     = useState(false);
  const [loginUser,     setLoginUser]     = useState('');
  const [loginPass,     setLoginPass]     = useState('');
  const [loginError,    setLoginError]    = useState('');

  // Sync chipUid from URL path
  useEffect(() => {
    if (chipUid) {
      const chip = lookupChip(chipUid);
      if (chip) setSelectedUID(chip.uid);
    }
  }, [chipUid]);

  // markPaid: LNbits hat die Einzahlung bestaetigt (Poll returned paid:true).
  // Published Kind-3493 mit type:"reload" damit die App es sieht und
  // den Chip auf "valid" setzen darf.
  const markPaid = useCallback((uid: string, at: string, hash: string) => {
    savePaidChip(uid, at);
    setPaidChips(prev => ({ ...prev, [uid]: at }));
    // Wenn der Chip vorher ausgezahlt war und jetzt erneut bezahlt wird,
    // entferne ihn aus payoutDone damit er wieder als "valid" angezeigt wird
    const normUID = normalizeUID(uid);
    setPayoutDone(prev => {
      if (prev.has(normUID)) {
        const next = new Set(prev);
        next.delete(normUID);
        localStorage.setItem(PAYOUT_DONE_KEY, JSON.stringify([...next]));
        return next;
      }
      return prev;
    });
    // Kind-3493 mit type:"reload" publishen — App erkennt daran dass Einzahlung ok ist
    void publishEvent({
      kind: KIND_PAYMENT_CONFIRMED,
      content: JSON.stringify({ uid, paymentHash: hash, type: 'reload', paidAt: at }),
      tags: [['t', APP_TAG], ['alt', 'Bitcoin Note reload payment confirmed']],
    });
  }, [publishEvent]);

  const markUnloaded = useCallback((uid: string) => {
    clearPaidChip(uid);
    setPaidChips(prev => { const n = { ...prev }; delete n[uid]; return n; });
  }, []);

  const markPayoutDone = useCallback((uid: string) => {
    savePayoutDone(uid);
    clearPaidChip(uid);
    const normUID = normalizeUID(uid);
    setPayoutDone(prev => new Set([...prev, normUID]));
    setPaidChips(prev => { const n = { ...prev }; delete n[uid]; return n; });
  }, []);

  const handleRefresh = useCallback(() => {
    void refetchLogs(); void refetchReloads(); void refetchInvalidates();
  }, [refetchLogs, refetchReloads, refetchInvalidates]);

  const handleAdminLogin = useCallback(() => {
    if (loginUser === ADMIN_USER && loginPass === ADMIN_PASS) {
      setIsAdmin(true);
      localStorage.setItem(ADMIN_STORAGE_KEY, 'true');
      setShowLogin(false);
      setLoginUser('');
      setLoginPass('');
      setLoginError('');
    } else {
      setLoginError('Falscher Benutzername oder Passwort');
    }
  }, [loginUser, loginPass]);

  const handleAdminLogout = useCallback(() => {
    setIsAdmin(false);
    localStorage.removeItem(ADMIN_STORAGE_KEY);
  }, []);

  // Admin: Reset chip status (entferne paidChips + payoutDone Eintraege)
  const adminResetChip = useCallback((uid: string) => {
    clearPaidChip(uid);
    setPaidChips(prev => { const n = { ...prev }; delete n[uid]; return n; });
    const normUID = normalizeUID(uid);
    setPayoutDone(prev => {
      const next = new Set(prev);
      next.delete(normUID);
      localStorage.setItem(PAYOUT_DONE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Admin: Manuell als bezahlt markieren
  const adminMarkPaid = useCallback((uid: string) => {
    const at = new Date().toLocaleString('de-DE') + ' (Admin)';
    savePaidChip(uid, at);
    setPaidChips(prev => ({ ...prev, [uid]: at }));
    const normUID = normalizeUID(uid);
    setPayoutDone(prev => {
      if (prev.has(normUID)) {
        const next = new Set(prev);
        next.delete(normUID);
        localStorage.setItem(PAYOUT_DONE_KEY, JSON.stringify([...next]));
        return next;
      }
      return prev;
    });
  }, []);

  // Admin: Manuell als ausgezahlt markieren
  const adminMarkPayoutDone = useCallback((uid: string) => {
    markPayoutDone(uid);
  }, [markPayoutDone]);

  const selectedChip  = selectedUID ? CHIP_REGISTRY.find(c => c.uid === selectedUID) ?? null : null;
  const selectedIndex = selectedUID ? CHIP_REGISTRY.findIndex(c => c.uid === selectedUID) : -1;

  // Resolve selected chip's invalidate request
  const selectedInvalidateReq = selectedUID
    ? latestInvalidateRequest(invalidateRequests, selectedUID)
    : null;

  return (
    <div className="min-h-screen"
      style={{ background: 'linear-gradient(160deg, #08070d 0%, #0e0c00 60%, #08070d 100%)', color: 'white' }}>
      {/* Ambient glow */}
      <div className="fixed inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(247,147,26,0.06) 0%, transparent 70%)' }} />

      {/* ── Header ── */}
      <header className="relative z-10 flex items-center justify-between px-4 py-3 gap-2"
        style={{ borderBottom: '1px solid rgba(247,147,26,0.07)', backdropFilter: 'blur(8px)' }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center"
            style={{ background: 'rgba(247,147,26,0.12)', border: '1px solid rgba(247,147,26,0.2)' }}>
            <Bitcoin className="w-4 h-4" style={{ color: '#f7931a' }} />
          </div>
          <div className="min-w-0">
            <div className="font-black text-sm tracking-widest uppercase truncate" style={{ color: 'rgba(255,255,255,0.9)' }}>
              Backup Chip
            </div>
            <div className="text-[9px] tracking-wider" style={{ color: 'rgba(247,147,26,0.4)' }}>
              Bitcoin Note Verifier
            </div>
          </div>
        </div>
        <a href={DOWNLOAD_URL} download="BitcoinNoteVerifier.apk"
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold"
          style={{ background: 'rgba(247,147,26,0.1)', border: '1px solid rgba(247,147,26,0.2)', color: '#f7931a' }}>
          <Download className="w-3 h-3" />
          <span className="hidden sm:inline">APK</span>
        </a>
      </header>

      {/* ── Tab bar ── */}
      {!selectedUID && (
        <div className="relative z-10 flex" style={{ borderBottom: '1px solid rgba(247,147,26,0.07)' }}>
          {([
            ['overview', 'Scheine', LayoutGrid],
            ['database', 'Verwaltung', Database],
          ] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold transition-all"
              style={{
                color: tab === id ? '#f7931a' : 'rgba(255,255,255,0.25)',
                borderBottom: tab === id ? '2px solid #f7931a' : '2px solid transparent',
              }}>
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      )}

      <main className="relative z-10 max-w-2xl mx-auto px-3 sm:px-4 py-5 space-y-5">

        {/* ── Chip Detail ── */}
        {selectedUID && selectedChip && (
          <ChipDetailPage
            chip={selectedChip}
            index={selectedIndex}
            resolvedStatus={resolveChipStatus(
              selectedChip,
              payoutDone,
              paidChips,
              !!selectedInvalidateReq,
            )}
            paidAt={paidChips[selectedUID] ?? null}
            hasReloadRequest={latestReloadRequest(reloadRequests, selectedUID) !== null || sessionReloads.has(selectedUID)}
            requestedAt={latestReloadRequest(reloadRequests, selectedUID)?.timestamp ?? null}
            sessionRequested={sessionReloads.has(selectedUID)}
            onPaid={(at, hash) => markPaid(selectedUID, at, hash)}
            onUnload={() => markUnloaded(selectedUID)}
            onBack={() => { setSelectedUID(null); navigate('/'); }}
            onPayoutDone={() => markPayoutDone(selectedUID)}
            verifyLogs={verifyLogs}
            invalidateRequest={selectedInvalidateReq
              ? { invoice: selectedInvalidateReq.invoice, sats: selectedInvalidateReq.sats, requestedAt: selectedInvalidateReq.timestamp }
              : null}
          />
        )}

        {/* ── Overview Tab ── */}
        {!selectedUID && tab === 'overview' && (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Scheine', value: CHIP_REGISTRY.length, color: 'rgba(247,147,26,0.7)' },
                {
                  label: 'Valid',
                  value: CHIP_REGISTRY.filter(c => resolveChipStatus(c, payoutDone, paidChips, !!latestInvalidateRequest(invalidateRequests, c.uid)) === 'valid').length,
                  color: '#34d399',
                },
                { label: 'Verif.', value: logsLoading ? '…' : verifyLogs.length, color: 'rgba(255,255,255,0.5)' },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl p-3 text-center"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-xl font-black" style={{ color }}>{value}</div>
                  <div className="text-[10px] font-bold tracking-wider uppercase mt-0.5"
                    style={{ color: 'rgba(255,255,255,0.25)' }}>{label}</div>
                </div>
              ))}
            </div>

            {/* List header */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black" style={{ color: 'rgba(255,255,255,0.7)' }}>Alle Scheine</h2>
              <button onClick={handleRefresh} className="p-1.5 rounded-lg"
                style={{ background: 'rgba(247,147,26,0.06)', border: '1px solid rgba(247,147,26,0.12)', color: 'rgba(247,147,26,0.6)' }}>
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>

            {/* Chip list */}
            <div className="space-y-2">
              {CHIP_REGISTRY.map((chip, i) => {
                const last   = verifyLogs.find(l => normalizeUID(l.uid) === normalizeUID(chip.uid));
                const rStatus = resolveChipStatus(chip, payoutDone, paidChips, !!latestInvalidateRequest(invalidateRequests, chip.uid));
                const hasInv = !!latestInvalidateRequest(invalidateRequests, chip.uid);

                return (
                  <button key={chip.uid} onClick={() => setSelectedUID(chip.uid)}
                    className="w-full text-left rounded-2xl px-3 py-3 transition-all active:scale-[0.99] hover:opacity-90"
                    style={{
                      background: rStatus === 'invalid' ? 'rgba(239,68,68,0.03)' :
                                  rStatus === 'entwertenbeantragt' ? 'rgba(249,115,22,0.03)' :
                                  'rgba(255,255,255,0.02)',
                      border: `1px solid ${
                        rStatus === 'invalid' ? 'rgba(239,68,68,0.12)' :
                        rStatus === 'entwertenbeantragt' ? 'rgba(249,115,22,0.12)' :
                        hasInv ? 'rgba(239,68,68,0.15)' :
                        'rgba(255,255,255,0.06)'}`,
                    }}>
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black flex-shrink-0"
                        style={{ background: 'rgba(247,147,26,0.08)', color: 'rgba(247,147,26,0.5)', border: '1px solid rgba(247,147,26,0.12)' }}>
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-black text-base" style={{ color: '#f7931a' }}>
                            {chip.sats.toLocaleString('de-DE')} sats
                          </span>
                          <ChipStatusBadge status={rStatus} small />
                        </div>
                        <div className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'rgba(255,255,255,0.25)' }}>
                          {chip.uid}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {last && <ResultBadge result={last.result} />}
                        <ChevronDown className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.15)', transform: 'rotate(-90deg)' }} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* APK Download */}
            <div className="flex flex-col items-center gap-3 pt-4">
              <a href={DOWNLOAD_URL} download="BitcoinNoteVerifier.apk"
                className="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold text-sm transition-all hover:scale-105"
                style={{ background: 'linear-gradient(135deg, #f7931a 0%, #e07b10 100%)', color: '#0a0800', boxShadow: '0 0 24px rgba(247,147,26,0.2)' }}>
                <Download className="w-4 h-4" strokeWidth={2.5} /> Android App herunterladen
              </a>
            </div>
          </div>
        )}

        {/* ── Database / Admin Tab ── */}
        {!selectedUID && tab === 'database' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.8)' }}>
                <Database className="w-4 h-4" style={{ color: '#f7931a' }} /> Chip-Verwaltung
              </h2>
              <button onClick={handleRefresh} className="p-1.5 rounded-lg"
                style={{ background: 'rgba(247,147,26,0.06)', border: '1px solid rgba(247,147,26,0.12)', color: 'rgba(247,147,26,0.6)' }}>
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>

            {/* Admin: Alle Status cleanen */}
            {isAdmin && (
              <div className="rounded-2xl p-3 space-y-2"
                style={{ background: 'rgba(239,68,68,0.03)', border: '1px solid rgba(239,68,68,0.12)' }}>
                <div className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5" style={{ color: '#f87171' }} />
                  <span className="text-xs font-bold" style={{ color: '#f87171' }}>Admin-Werkzeuge</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => {
                    CHIP_REGISTRY.forEach(c => adminResetChip(c.uid));
                  }}
                    className="text-[10px] px-3 py-1.5 rounded-xl font-bold flex items-center gap-1.5"
                    style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                    <Trash2 className="w-3 h-3" /> Alle Chips zuruecksetzen
                  </button>
                  <button onClick={() => {
                    localStorage.removeItem(PAID_STORAGE_KEY);
                    localStorage.removeItem(PAYOUT_DONE_KEY);
                    setPaidChips({});
                    setPayoutDone(new Set());
                  }}
                    className="text-[10px] px-3 py-1.5 rounded-xl font-bold flex items-center gap-1.5"
                    style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)', color: '#fb923c' }}>
                    <Trash2 className="w-3 h-3" /> localStorage leeren
                  </button>
                </div>
              </div>
            )}

            {/* Pending Entwertungen */}
            {invalidateRequests.filter(r => r.chipStatus === 'invalid').length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2"
                  style={{ color: '#f87171' }}>
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Offene Entwertungen ({invalidateRequests.filter(r => r.chipStatus === 'invalid' && !payoutDone.has(normalizeUID(r.uid))).length})
                </h3>
                {invalidateRequests
                  .filter(r => r.chipStatus === 'invalid' && !payoutDone.has(normalizeUID(r.uid)))
                  .slice(0, 5)
                  .map(req => {
                    const chip = CHIP_REGISTRY.find(c => normalizeUID(c.uid) === normalizeUID(req.uid));
                    return (
                      <div key={req.id} className="rounded-2xl p-3 space-y-2"
                        style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.15)' }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <ShieldX className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#f87171' }} />
                          <span className="font-black text-sm" style={{ color: '#f7931a' }}>
                            {(chip?.sats ?? req.sats).toLocaleString('de-DE')} sats
                          </span>
                          <span className="font-mono text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                            {req.uid}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setSelectedUID(req.uid)}
                            className="flex-1 h-8 rounded-xl text-xs font-bold flex items-center justify-center gap-2"
                            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                            <Send className="w-3 h-3" /> Zur Auszahlung
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => adminMarkPayoutDone(req.uid)}
                              className="h-8 px-3 rounded-xl text-[10px] font-bold flex items-center gap-1"
                              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', color: '#34d399' }}>
                              <Check className="w-3 h-3" /> Erledigt
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* All chips */}
            <div className="space-y-2">
              {CHIP_REGISTRY.map((chip, i) => {
                const last       = verifyLogs.find(l => normalizeUID(l.uid) === normalizeUID(chip.uid));
                const paidAt     = paidChips[chip.uid] ?? null;
                const reloadReq  = latestReloadRequest(reloadRequests, chip.uid);
                const hasReload  = reloadReq !== null || sessionReloads.has(chip.uid);
                const invReq     = latestInvalidateRequest(invalidateRequests, chip.uid);
                const rStatus    = resolveChipStatus(chip, payoutDone, paidChips, !!invReq);

                return (
                  <div key={chip.uid} className="rounded-2xl p-3 space-y-2.5"
                    style={{
                      background: rStatus === 'invalid' ? 'rgba(239,68,68,0.03)' :
                                  paidAt ? 'rgba(16,185,129,0.03)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${rStatus === 'invalid' ? 'rgba(239,68,68,0.12)' : paidAt ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.06)'}`,
                    }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0"
                        style={{ background: 'rgba(247,147,26,0.08)', color: 'rgba(247,147,26,0.5)', border: '1px solid rgba(247,147,26,0.12)' }}>
                        #{i + 1}
                      </span>
                      <span className="font-black" style={{ color: '#f7931a' }}>{chip.sats.toLocaleString('de-DE')} sats</span>
                      <ChipStatusBadge status={rStatus} small />
                      {last && <ResultBadge result={last.result} />}
                    </div>
                    <div className="font-mono text-[10px] break-all" style={{ color: 'rgba(255,255,255,0.25)' }}>{chip.uid}</div>
                    <div className="pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                      {invReq && !payoutDone.has(normalizeUID(chip.uid)) ? (
                        <button onClick={() => setSelectedUID(chip.uid)}
                          className="inline-flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-xl font-bold"
                          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                          <Send className="w-2.5 h-2.5" /> Entwertungs-Anfrage verarbeiten
                        </button>
                      ) : (
                        <InvoiceCell
                          chip={chip} paidAt={paidAt}
                          hasReloadRequest={hasReload} requestedAt={reloadReq?.timestamp ?? null}
                          onPaid={(at, hash) => markPaid(chip.uid, at, hash)}
                          onUnload={() => markUnloaded(chip.uid)}
                          sessionRequested={sessionReloads.has(chip.uid)}
                          compact
                        />
                      )}
                      {/* Admin actions */}
                      {isAdmin && (
                        <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <button onClick={() => adminResetChip(chip.uid)}
                            className="text-[9px] px-2 py-0.5 rounded flex items-center gap-1"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: 'rgba(239,68,68,0.6)' }}>
                            <Trash2 className="w-2.5 h-2.5" /> Reset
                          </button>
                          <button onClick={() => adminMarkPaid(chip.uid)}
                            className="text-[9px] px-2 py-0.5 rounded flex items-center gap-1"
                            style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', color: 'rgba(16,185,129,0.6)' }}>
                            <Edit className="w-2.5 h-2.5" /> Bezahlt setzen
                          </button>
                          <button onClick={() => adminMarkPayoutDone(chip.uid)}
                            className="text-[9px] px-2 py-0.5 rounded flex items-center gap-1"
                            style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.15)', color: 'rgba(249,115,22,0.6)' }}>
                            <ShieldX className="w-2.5 h-2.5" /> Ausgezahlt setzen
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Verify Log */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-black flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.8)' }}>
                  <Wifi className="w-4 h-4" style={{ color: '#f7931a' }} /> Verifikations-Log
                </h3>
                <button onClick={() => void refetchLogs()} className="p-1.5 rounded-lg"
                  style={{ background: 'rgba(247,147,26,0.06)', border: '1px solid rgba(247,147,26,0.12)', color: 'rgba(247,147,26,0.6)' }}>
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              {logsLoading ? (
                <div className="space-y-2">{[...Array(3)].map((_, k) => <div key={k} className="h-10 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />)}</div>
              ) : verifyLogs.length === 0 ? (
                <div className="rounded-2xl flex flex-col items-center py-8 gap-2" style={{ border: '1.5px dashed rgba(247,147,26,0.1)' }}>
                  <Clock className="w-6 h-6" style={{ color: 'rgba(247,147,26,0.15)' }} />
                  <p className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>Noch keine Verifikationen.</p>
                </div>
              ) : (
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  {verifyLogs.slice(0, 20).map((log, i) => (
                    <div key={log.id} className="flex items-center justify-between px-3 py-2.5"
                      style={{ borderBottom: i < Math.min(verifyLogs.length, 20) - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.45)' }}>
                          {log.uid.length > 8 ? `${log.uid.slice(0, 4)}…${log.uid.slice(-4)}` : log.uid}
                        </span>
                        <ResultBadge result={log.result} />
                      </div>
                      <span className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>{formatTs(log.timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Admin Login Dialog ── */}
      {showLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowLogin(false)}>
          <div className="rounded-2xl p-6 w-80 space-y-4"
            onClick={e => e.stopPropagation()}
            style={{ background: '#151015', border: '1px solid rgba(247,147,26,0.2)' }}>
            <div className="flex items-center gap-2">
              <Lock className="w-5 h-5" style={{ color: '#f7931a' }} />
              <h3 className="text-sm font-black" style={{ color: '#f7931a' }}>Admin Login</h3>
            </div>
            <div className="space-y-2">
              <input type="text" placeholder="Benutzername" value={loginUser}
                onChange={e => setLoginUser(e.target.value)}
                className="w-full h-9 rounded-xl px-3 text-sm font-mono"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'white' }} />
              <input type="password" placeholder="Passwort" value={loginPass}
                onChange={e => setLoginPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAdminLogin(); }}
                className="w-full h-9 rounded-xl px-3 text-sm font-mono"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'white' }} />
            </div>
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
            <button onClick={handleAdminLogin}
              className="w-full h-10 rounded-xl font-bold text-sm"
              style={{ background: 'rgba(247,147,26,0.15)', border: '1px solid rgba(247,147,26,0.3)', color: '#f7931a' }}>
              <LogIn className="w-4 h-4 inline mr-2" /> Anmelden
            </button>
          </div>
        </div>
      )}

      <footer className="relative z-10 py-4 px-4 flex items-center justify-between"
        style={{ borderTop: '1px solid rgba(247,147,26,0.05)' }}>
        <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer"
          className="text-xs hover:opacity-70 transition-opacity" style={{ color: 'rgba(255,255,255,0.12)' }}>
          Vibed with Shakespeare
        </a>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <button onClick={handleAdminLogout}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: 'rgba(239,68,68,0.6)' }}>
              <LogOut className="w-3 h-3" /> Abmelden
            </button>
          ) : (
            <button onClick={() => setShowLogin(true)}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.15)' }}>
              <Lock className="w-3 h-3" /> Admin
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
