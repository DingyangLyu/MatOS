// @vitest-environment jsdom

// The TOS material-bench archive registers hundreds of generated dataset/paper
// unit data assets. The asset detail page must surface their upstream identity
// (DOI, source links, payload status, archive paths, catalog query) instead of
// burying it in the raw asset.json disclosure.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DataProvenanceCard } from '../../src/components/AssetsView';
import { dataProvenanceFromAssetJson } from '../../src/components/asset-editors';

afterEach(cleanup);

describe('DataProvenanceCard', () => {
  it('renders DOI links, source URLs, payload state, and the catalog query', () => {
    const fields = dataProvenanceFromAssetJson(
      JSON.stringify({
        type: 'data',
        id: 'mb-zenodo-7026970',
        metadata: {
          sourceFormat: 'material-bench-unit',
          generatedBy: 'scripts/material-bench-units-to-assets.py',
          provider: 'zenodo',
          providerId: '7026970',
          unitKind: 'dataset-record',
          doi: '10.5281/zenodo.7026970',
          sourceUrl: 'https://zenodo.org/records/7026970',
          payloadStatus: 'archived-tos',
          payloadKind: 'data',
          sizeHuman: '7.189 GiB',
          recordCount: 12,
          collections: ['multidomain_batch11_20260506'],
          path: '/workspace/knowledge/material-bench-datasets/multidomain_batch11_20260506',
          payloadPaths: ['/workspace/knowledge/material-bench-datasets/multidomain_batch11_20260506'],
          tosArchive: 'tos-example-bucket/example-user/material-bench-datasets-20260430/downloads',
          catalogTool: 'mcp__matos_asset__material_bench_dataset_catalog',
          recommendedQuery: { recordKind: 'unit', query: '7026970' },
        },
      }),
    );

    render(<DataProvenanceCard fields={fields} />);

    const doiLink = screen.getByRole('link', { name: /10\.5281\/zenodo\.7026970/ });
    expect(doiLink.getAttribute('href')).toBe('https://doi.org/10.5281/zenodo.7026970');
    const sourceLink = screen.getByRole('link', { name: /zenodo\.org\/records\/7026970/ });
    expect(sourceLink.getAttribute('href')).toBe('https://zenodo.org/records/7026970');
    expect(screen.getByText('archived-tos')).toBeTruthy();
    expect(screen.getByText('7.189 GiB')).toBeTruthy();
    expect(screen.getByText(/zenodo · 7026970/)).toBeTruthy();
    expect(screen.getByText('multidomain_batch11_20260506')).toBeTruthy();
    expect(screen.getByText('mcp__matos_asset__material_bench_dataset_catalog')).toBeTruthy();
    expect(screen.getByText('{"recordKind":"unit","query":"7026970"}')).toBeTruthy();
    expect(
      screen.getByText('tos://tos-example-bucket/example-user/material-bench-datasets-20260430/downloads'),
    ).toBeTruthy();
  });

  it('marks metadata-only units and surfaces curation issues', () => {
    const fields = dataProvenanceFromAssetJson(
      JSON.stringify({
        type: 'data',
        id: 'mb-coll-hiscibench',
        metadata: {
          generatedBy: 'scripts/material-bench-units-to-assets.py',
          provider: 'local',
          providerId: 'hiscibench',
          unitKind: 'local-collection',
          sourceUrl: 'https://arxiv.org/abs/2512.22899',
          payloadStatus: 'archived-tos',
          payloadKind: 'metadata-snapshot',
          curationIssues: ['directory-level-unit'],
        },
      }),
    );

    render(<DataProvenanceCard fields={fields} />);
    expect(screen.getByText('metadata-snapshot')).toBeTruthy();
    expect(screen.getByText('directory-level-unit')).toBeTruthy();
  });
});
