// Illustrative "intent" thumbnails for the Home scenario rail.
//
// Each create-rail card used to show a single line icon, which reads the same
// for every scenario at a glance. These mini-mockups instead *depict* the
// artifact the card produces — a browser window for Prototype, a slide stack
// for Slide deck, a page for Document, a waveform for Audio — so the user can
// recognize the card by shape, like the reference design rails do.
//
// Two-tone, token-driven, no hardcoded colors: neutral ink for structure
// (`--text-muted`) plus a single `--accent` highlight per illustration so the
// eye lands on the meaningful part. Drawn in a shared 60×42 viewBox.

import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

const INK = 'var(--text-muted)';
const ACCENT = 'var(--accent)';
// Opaque fill used to occlude shapes stacked behind another (slide/frame peeks)
// so overlapping outlines don't show through. Tracks the card-art surface.
const SURFACE = 'var(--bg-panel)';

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      className="home-hero__scenario-art-svg"
      viewBox="0 0 60 42"
      width={60}
      height={42}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function PrototypeArt() {
  // Browser/app window: chrome bar with dots, an accent CTA, body lines.
  return (
    <Frame>
      <rect x="6" y="7" width="48" height="28" rx="4" stroke={INK} strokeWidth="2" />
      <line x1="6" y1="15" x2="54" y2="15" stroke={INK} strokeWidth="2" />
      <circle cx="10.5" cy="11" r="1.1" fill={INK} />
      <circle cx="14.5" cy="11" r="1.1" fill={INK} />
      <circle cx="18.5" cy="11" r="1.1" fill={INK} />
      <rect x="11" y="20" width="13" height="5" rx="1.5" fill={ACCENT} />
      <line x1="28" y1="21" x2="48" y2="21" stroke={INK} strokeWidth="2" />
      <line x1="28" y1="26" x2="42" y2="26" stroke={INK} strokeWidth="2" />
      <line x1="11" y1="30" x2="48" y2="30" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function WireframeArt() {
  // Lo-fi greybox screen: a dashed frame (the wireframe tell) over placeholder
  // blocks and an accent CTA placeholder.
  return (
    <Frame>
      <rect x="6" y="7" width="48" height="28" rx="4" stroke={INK} strokeWidth="2" strokeDasharray="3.5 3" />
      <rect x="11" y="12" width="38" height="6" rx="1.5" fill={INK} fillOpacity="0.16" />
      <rect x="11" y="22" width="16" height="9" rx="1.5" fill={INK} fillOpacity="0.16" />
      <rect x="31" y="22" width="11" height="5" rx="1.5" fill={ACCENT} />
      <line x1="31" y1="30" x2="49" y2="30" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function MobileArt() {
  // Phone with status notch, content lines, and an accent bottom bar.
  return (
    <Frame>
      <rect x="22" y="4" width="16" height="34" rx="3.5" stroke={INK} strokeWidth="2" />
      <line x1="27.5" y1="7.5" x2="32.5" y2="7.5" stroke={INK} strokeWidth="1.6" />
      <line x1="26" y1="14" x2="34" y2="14" stroke={INK} strokeWidth="2" />
      <line x1="26" y1="19" x2="34" y2="19" stroke={INK} strokeWidth="2" />
      <line x1="26" y1="24" x2="31" y2="24" stroke={INK} strokeWidth="2" />
      <rect x="26" y="29" width="8" height="4" rx="1.5" fill={ACCENT} />
    </Frame>
  );
}

function DeckArt() {
  // Slide deck: a peeking back slide plus a front slide with accent title.
  return (
    <Frame>
      <rect x="15" y="6" width="38" height="24" rx="3" stroke={INK} strokeWidth="2" strokeOpacity="0.45" />
      <rect x="7" y="11" width="38" height="24" rx="3" fill={SURFACE} stroke={INK} strokeWidth="2" />
      <rect x="11" y="15" width="14" height="5" rx="1.5" fill={ACCENT} />
      <line x1="11" y1="25" x2="41" y2="25" stroke={INK} strokeWidth="2" />
      <line x1="11" y1="30" x2="34" y2="30" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function DocumentArt() {
  // Portrait page with a folded corner, accent title line, body lines.
  return (
    <Frame>
      <path d="M17 5 H37 L43 11 V37 H17 Z" fill={SURFACE} stroke={INK} strokeWidth="2" />
      <path d="M37 5 V11 H43" stroke={INK} strokeWidth="2" />
      <line x1="21" y1="17" x2="38" y2="17" stroke={ACCENT} strokeWidth="2" />
      <line x1="21" y1="22" x2="39" y2="22" stroke={INK} strokeWidth="2" />
      <line x1="21" y1="27" x2="39" y2="27" stroke={INK} strokeWidth="2" />
      <line x1="21" y1="32" x2="33" y2="32" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function BrandKitArt() {
  // Style tile: a row of color swatches (one accent) over two type lines.
  return (
    <Frame>
      <rect x="8" y="9" width="13" height="13" rx="2.5" fill={ACCENT} />
      <rect x="24" y="9" width="13" height="13" rx="2.5" fill={INK} fillOpacity="0.18" stroke={INK} strokeWidth="2" />
      <rect x="40" y="9" width="13" height="13" rx="2.5" stroke={INK} strokeWidth="2" />
      <line x1="8" y1="29" x2="42" y2="29" stroke={INK} strokeWidth="2" />
      <line x1="8" y1="34" x2="30" y2="34" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

// --- MatOS template art ------------------------------------------------
// Same two-tone frame language as the OD scenario art above, but depicting
// MatOS objects: a crystal lattice for compute tasks, a DAG for workflows,
// an agent node for roles, and so on (see matos-chips.ts).

function MatOSComputeArt() {
  // Hexagonal unit cell with a highlighted central atom — the MatOS mark.
  return (
    <Frame>
      <path d="M30 8 L44 15 L44 28 L30 35 L16 28 L16 15 Z" stroke={INK} strokeWidth="2" />
      <line x1="30" y1="8" x2="30" y2="21.5" stroke={INK} strokeWidth="1.6" />
      <line x1="44" y1="28" x2="30" y2="21.5" stroke={INK} strokeWidth="1.6" />
      <line x1="16" y1="28" x2="30" y2="21.5" stroke={INK} strokeWidth="1.6" />
      <circle cx="30" cy="8" r="2.4" fill={INK} />
      <circle cx="44" cy="15" r="2.4" fill={INK} />
      <circle cx="44" cy="28" r="2.4" fill={INK} />
      <circle cx="30" cy="35" r="2.4" fill={INK} />
      <circle cx="16" cy="28" r="2.4" fill={INK} />
      <circle cx="16" cy="15" r="2.4" fill={INK} />
      <circle cx="30" cy="21.5" r="4" fill={ACCENT} />
    </Frame>
  );
}

function MatOSWorkflowArt() {
  // Left-to-right DAG: source node fans out, merges into an accent sink.
  return (
    <Frame>
      <path d="M14 21 C20 21 20 12 26 12 L34 12" stroke={INK} strokeWidth="2" />
      <path d="M14 21 C20 21 20 30 26 30 L34 30" stroke={INK} strokeWidth="2" />
      <path d="M38 12 C44 12 44 21 48 21" stroke={INK} strokeWidth="2" />
      <path d="M38 30 C44 30 44 21 48 21" stroke={INK} strokeWidth="2" />
      <circle cx="12" cy="21" r="3.5" stroke={INK} strokeWidth="2" fill={SURFACE} />
      <rect x="33" y="8" width="8" height="8" rx="2" stroke={INK} strokeWidth="2" fill={SURFACE} />
      <rect x="33" y="26" width="8" height="8" rx="2" stroke={INK} strokeWidth="2" fill={SURFACE} />
      <circle cx="50" cy="21" r="4" fill={ACCENT} />
    </Frame>
  );
}

function MatOSRoleArt() {
  // Agent core with mounted satellites (skills / tools / knowledge).
  return (
    <Frame>
      <circle cx="30" cy="21" r="7" stroke={INK} strokeWidth="2" />
      <circle cx="30" cy="21" r="2.6" fill={ACCENT} />
      <line x1="30" y1="14" x2="30" y2="8" stroke={INK} strokeWidth="1.6" />
      <line x1="36" y1="25" x2="46" y2="30" stroke={INK} strokeWidth="1.6" />
      <line x1="24" y1="25" x2="14" y2="30" stroke={INK} strokeWidth="1.6" />
      <circle cx="30" cy="6.5" r="2.6" fill={INK} />
      <circle cx="47.5" cy="31" r="2.6" fill={INK} />
      <circle cx="12.5" cy="31" r="2.6" fill={INK} />
    </Frame>
  );
}

function MatOSSkillArt() {
  // Checklist card: steps with an accent check on the completed one.
  return (
    <Frame>
      <rect x="10" y="7" width="40" height="28" rx="4" stroke={INK} strokeWidth="2" />
      <path d="M15 15 L17.5 17.5 L21.5 12.5" stroke={ACCENT} strokeWidth="2.2" />
      <line x1="26" y1="15" x2="45" y2="15" stroke={INK} strokeWidth="2" />
      <circle cx="18" cy="23" r="1.4" fill={INK} />
      <line x1="26" y1="23" x2="42" y2="23" stroke={INK} strokeWidth="2" />
      <circle cx="18" cy="29" r="1.4" fill={INK} />
      <line x1="26" y1="29" x2="38" y2="29" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function MatOSToolArt() {
  // Terminal window with an accent prompt chevron.
  return (
    <Frame>
      <rect x="8" y="8" width="44" height="26" rx="4" stroke={INK} strokeWidth="2" />
      <path d="M14 16 L20 21 L14 26" stroke={ACCENT} strokeWidth="2.4" />
      <line x1="25" y1="26" x2="38" y2="26" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function MatOSKnowledgeArt() {
  // Open book with an accent bookmark.
  return (
    <Frame>
      <path d="M30 11 C25 8 18 8 13 10 V32 C18 30 25 30 30 33 C35 30 42 30 47 32 V10 C42 8 35 8 30 11 Z" stroke={INK} strokeWidth="2" />
      <line x1="30" y1="11" x2="30" y2="33" stroke={INK} strokeWidth="2" />
      <line x1="17" y1="16" x2="26" y2="15" stroke={INK} strokeWidth="1.6" />
      <line x1="17" y1="21" x2="26" y2="20" stroke={INK} strokeWidth="1.6" />
      <path d="M38 9.5 V18 L41 15.5 L44 18 V9.5" fill={ACCENT} />
    </Frame>
  );
}

function MatOSDataArt() {
  // Database cylinder with an accent top disc.
  return (
    <Frame>
      <ellipse cx="30" cy="11" rx="14" ry="4.5" fill={ACCENT} />
      <path d="M16 11 V31 C16 33.5 22.3 35.5 30 35.5 C37.7 35.5 44 33.5 44 31 V11" stroke={INK} strokeWidth="2" />
      <path d="M16 18 C16 20.5 22.3 22.5 30 22.5 C37.7 22.5 44 20.5 44 18" stroke={INK} strokeWidth="2" />
      <path d="M16 25 C16 27.5 22.3 29.5 30 29.5 C37.7 29.5 44 27.5 44 25" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function MatOSImportArt() {
  // Repo box receiving an accent down-arrow (mirror into Mathub).
  return (
    <Frame>
      <path d="M30 6 V20 M30 20 L25 15 M30 20 L35 15" stroke={ACCENT} strokeWidth="2.4" />
      <path d="M12 24 H48 V34 C48 35.1 47.1 36 46 36 H14 C12.9 36 12 35.1 12 34 Z" stroke={INK} strokeWidth="2" />
      <line x1="18" y1="30" x2="26" y2="30" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

const ART_BY_CHIP: Record<string, () => ReactElement> = {
  prototype: PrototypeArt,
  wireframe: WireframeArt,
  mobile: MobileArt,
  deck: DeckArt,
  document: DocumentArt,
  'create-brand-kit': BrandKitArt,
  'matos-compute': MatOSComputeArt,
  'matos-workflow': MatOSWorkflowArt,
  'matos-role': MatOSRoleArt,
  'matos-skill': MatOSSkillArt,
  'matos-tool': MatOSToolArt,
  'matos-knowledge': MatOSKnowledgeArt,
  'matos-data': MatOSDataArt,
  'matos-import': MatOSImportArt,
};

interface ScenarioArtProps {
  chipId: string;
  // Rendered when a chip has no bespoke illustration yet, so new chips keep a
  // sensible glyph instead of an empty art slot.
  fallbackIcon: IconName;
}

export function ScenarioArt({ chipId, fallbackIcon }: ScenarioArtProps) {
  const Art = ART_BY_CHIP[chipId];
  if (Art) return <Art />;
  return <Icon name={fallbackIcon} size={24} aria-hidden />;
}
