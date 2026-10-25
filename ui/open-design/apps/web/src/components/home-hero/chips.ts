// Home intent rail.
//
// The Home input card sits naked above an unstructured prompt. New
// users frequently type a request without knowing which project kind
// to create, which lands them in the generic agent path and
// stretches the convergence loop. This chip rail exposes high-signal
// NewProjectModal categories plus a small set of lower-row shortcuts
// (template picker), so the same Enter keystroke can start a run with the
// right project kind. The generic "other" path stays in the free-form
// prompt instead of becoming a redundant chip.
//
// The catalog stays a pure data table:
//   - `id` — stable React key + test selector.
//   - `label` — English copy. Localisation can layer on later by
//     swapping this for a Dict lookup; keeping it inline lets the
//     rail ship without burning through 17 locale files for two
//     new strings (see plan §B / open questions).
//   - `icon` — name from the shared Icon registry.
//   - `action` — discriminated union the HomeView dispatcher matches
//     on. The rail component itself stays presentational.

import type { ProjectKind, ProjectMetadata } from '@open-design/contracts';
import type { IconName } from '../Icon';

export type ChipAction =
  | {
      kind: 'create-project';
      projectKind: ProjectKind;
      projectMetadata?: ProjectMetadata;
    }
  | { kind: 'open-template-picker' };

// Two intent groups: "create" = produce a design artifact, "migrate" =
// lower-row starter shortcuts such as templates. The grouping is structural
// only — HomeHero renders the two groups in separate flex containers so they
// wrap onto separate rows on narrow viewports without horizontal scrolling.
export type ChipGroup = 'create' | 'migrate';

export interface HomeHeroChip {
  id: string;
  label: string;
  icon: IconName;
  group: ChipGroup;
  hint?: string;
  // Scenario subtitle shown under the title on the illustrated card rail
  // (e.g. "Interactive app mockups"). English inline fallback only — the
  // rendered copy is localized through the `homeHero.chip.<id>Desc` Dict key
  // (see `homeHeroChipDescription` in HomeHero.tsx). Kept on the data table so
  // the catalog reads as a self-contained scenario taxonomy.
  description?: string;
  action: ChipAction;
}

export const HOME_HERO_CHIPS: ReadonlyArray<HomeHeroChip> = [
  {
    id: 'prototype',
    label: 'Prototype',
    icon: 'palette',
    group: 'create',
    description: 'Interactive app mockups',
    action: {
      kind: 'create-project',
      projectKind: 'prototype',
    },
  },
  {
    id: 'wireframe',
    label: 'Wireframe',
    icon: 'layout',
    group: 'create',
    description: 'Lo-fi screens & flows',
    hint: 'Sketch lo-fi screens and flows to validate structure before visual design.',
    // Stamps a lo-fi fidelity so the project stays in structural/greybox
    // territory instead of jumping to high-fidelity styling.
    action: {
      kind: 'create-project',
      projectKind: 'prototype',
      projectMetadata: {
        kind: 'prototype',
        fidelity: 'wireframe',
      },
    },
  },
  {
    id: 'mobile',
    label: 'Mobile app',
    icon: 'smartphone',
    group: 'create',
    description: 'iOS & Android screens',
    hint: 'Lay out mobile screens for iOS and Android.',
    // Records mobile platform targets so the project frames screens for
    // handheld viewports.
    action: {
      kind: 'create-project',
      projectKind: 'prototype',
      projectMetadata: {
        kind: 'prototype',
        platform: 'auto',
        platformTargets: ['mobile-ios', 'mobile-android'],
      },
    },
  },
  {
    id: 'deck',
    label: 'Slide deck',
    icon: 'present',
    group: 'create',
    description: 'Presentations & pitch decks',
    action: {
      kind: 'create-project',
      projectKind: 'deck',
    },
  },
  {
    id: 'document',
    label: 'Document',
    icon: 'file-text',
    group: 'create',
    description: 'Resumes, reports & PDFs',
    hint: 'Draft a polished document — resume, report, or PDF — you can export.',
    // Documents (resumes / reports / PDFs) create a generic `other` project;
    // the agent composes the document layout from the brief.
    action: {
      kind: 'create-project',
      projectKind: 'other',
      projectMetadata: {
        kind: 'other',
        // Analytics-only tag: splits this card's projects out of generic
        // `other` so `project_kind` reports `document` (matches the task_chip).
        // No product behavior keys off `intent: 'document'`.
        intent: 'document',
      },
    },
  },
  {
    id: 'template',
    label: 'From template',
    icon: 'file-code',
    group: 'migrate',
    hint: 'Start from a bundled template.',
    action: { kind: 'open-template-picker' },
  },
];

export function chipsForGroup(group: ChipGroup): HomeHeroChip[] {
  return HOME_HERO_CHIPS.filter((c) => c.group === group);
}

// Display order for the inline `create` scenario rail. The composer leads with
// the slide deck ("Slides") followed by the core build scenarios in
// decreasing generality (Prototype → Wireframe → Mobile → Document).
// Any create chip not listed keeps its catalog order after the explicit
// entries (see `orderedCreateChips`).
export const CREATE_RAIL_ORDER = [
  'deck',
  'prototype',
  'wireframe',
  'mobile',
  'document',
] as const;

// The `create` chips in rail-display order. Listed ids come first in
// `CREATE_RAIL_ORDER`; any unlisted create chip trails in catalog order.
// Reordering through this helper keeps the catalog data table stable while
// letting the rail lead with the slide deck.
export function orderedCreateChips(): HomeHeroChip[] {
  const create = chipsForGroup('create');
  const listed = CREATE_RAIL_ORDER
    .map((id) => create.find((c) => c.id === id))
    .filter((c): c is HomeHeroChip => Boolean(c));
  const listedIds = new Set<string>(CREATE_RAIL_ORDER);
  const rest = create.filter((c) => !listedIds.has(c.id));
  return [...listed, ...rest];
}

// Helper used by tests + the rail component to pull the chip metadata
// off a click target without round-tripping through React state.
export function findChip(id: string): HomeHeroChip | undefined {
  return HOME_HERO_CHIPS.find((c) => c.id === id);
}
