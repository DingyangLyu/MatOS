import { useEffect, useState } from 'react';

const STORAGE_KEY = 'open-design:config';
const TOGGLE_EVENT = 'open-design:evolution-jury-toggle';

interface ConfigShape {
  matosEvolutionJuryEnabled?: boolean;
  [k: string]: unknown;
}

/**
 * Read the Settings-toggle flag for the MatOS self-evolution review panel
 * (自进化评审团), with one
 * deliberate difference: this toggle is purely a *visibility* switch.
 *
 * MatOS self-evolution is always-on server-side (the hidden critic → refiner →
 * editor → judge pipeline runs regardless), so there is no daemon-side gating
 * to keep in lockstep and no project-metadata round-trip. The flag only decides
 * whether the browser renders the live projection of that pipeline. That is why
 * the setter here writes localStorage + a same-tab CustomEvent only.
 *
 * Sync paths mirror the Theater hook:
 *   1. cross-tab `storage` events, and
 *   2. a same-tab `open-design:evolution-jury-toggle` CustomEvent carrying
 *      `detail.enabled` so a Settings save reflects without a reload even when
 *      localStorage is unwritable (private mode / quota).
 */
export function useEvolutionJuryEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => readToggle());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reload = (): void => setEnabled(readToggle());
    const onStorage = (evt: StorageEvent): void => {
      if (evt.key !== null && evt.key !== STORAGE_KEY) return;
      reload();
    };
    const onCustom = (evt: Event): void => {
      const detail = (evt as CustomEvent<{ enabled?: unknown }>).detail;
      if (detail && typeof detail.enabled === 'boolean') {
        setEnabled(detail.enabled);
        return;
      }
      reload();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(TOGGLE_EVENT, onCustom);
    reload();
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(TOGGLE_EVENT, onCustom);
    };
  }, []);
  return enabled;
}

/**
 * Imperative setter the Settings panel calls. Writes the stored config and
 * emits the same-tab CustomEvent so every mounted `useEvolutionJuryEnabled`
 * updates without a reload. No project PATCH: the flag is visibility-only.
 */
export function setEvolutionJuryEnabled(next: boolean): void {
  if (typeof window === 'undefined') return;
  let parsed: ConfigShape = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const candidate: unknown = JSON.parse(raw);
      if (candidate && typeof candidate === 'object') {
        parsed = candidate as ConfigShape;
      }
    }
  } catch {
    /* fall through to fresh object */
  }
  parsed.matosEvolutionJuryEnabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* private mode / quota: the event below still keeps mounts consistent. */
  }
  try {
    window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: { enabled: next } }));
  } catch {
    /* CustomEvent shim missing: single mount remains correct. */
  }
}

function readToggle(): boolean {
  if (typeof window === 'undefined') return false;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    return (parsed as ConfigShape).matosEvolutionJuryEnabled === true;
  } catch {
    return false;
  }
}
