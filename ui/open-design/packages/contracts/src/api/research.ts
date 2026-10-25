/**
 * Agent-callable research DTOs. The web/composer toggles `enabled`, the
 * daemon injects a command contract, and the agent may call
 * `od research search` to retrieve JSON findings.
 */

export type ResearchDepth = 'shallow' | 'medium' | 'deep';

export interface ResearchOptions {
  enabled: boolean;
  /** Optional override; defaults to the user's chat message. */
  query?: string;
  /** Phase 1 only honours 'shallow'. */
  depth?: ResearchDepth;
  /** Cap on returned sources. Defaults follow the depth. */
  maxSources?: number;
  /** Provider preference order. Phase 1 supports ['tavily']. */
  providers?: string[];
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  provider: string;
}

export interface ResearchFindings {
  query: string;
  summary: string;
  sources: ResearchSource[];
  provider: string;
  depth: ResearchDepth;
  /** Unix ms when the search returned. */
  fetchedAt: number;
}

export const RESEARCH_DEFAULT_MAX_SOURCES: Record<ResearchDepth, number> = {
  shallow: 5,
  medium: 12,
  deep: 30,
};


/**
 * Scientific-data API providers whose credentials the Settings surface stores
 * and the daemon injects into agent-authored code as environment variables.
 */
export interface ResearchProvider {
  id: string;
  label: string;
  hint: string;
  integrated: boolean;
  credentialsRequired?: boolean;
  settingsVisible?: boolean;
  supportsCustomModel?: boolean;
  customModelPlaceholder?: string;
  defaultBaseUrl?: string;
  docsUrl?: string;
  agentEnvVars?: string[];
}

export const RESEARCH_PROVIDERS: ResearchProvider[] = [
  { id: 'materials-project', label: 'Materials Project', hint: 'Materials database · pymatgen / mp-api', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.materialsproject.org', docsUrl: 'https://next-gen.materialsproject.org/api', agentEnvVars: ['MP_API_KEY', 'PMG_MAPI_KEY'] },
  { id: 'openalex', label: 'OpenAlex', hint: 'Scholarly works · authors · institutions', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.openalex.org', docsUrl: 'https://docs.openalex.org', agentEnvVars: ['OPENALEX_API_KEY', 'OPENALEX_MAILTO'] },
  { id: 'nomad', label: 'NOMAD', hint: 'Computational materials data repository', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://nomad-lab.eu/prod/v1/api', docsUrl: 'https://nomad-lab.eu/prod/v1/gui/analyze/apis', agentEnvVars: ['NOMAD_API_TOKEN'] },
  { id: 'semantic-scholar', label: 'Semantic Scholar', hint: 'Academic graph · papers · citations', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.semanticscholar.org', docsUrl: 'https://www.semanticscholar.org/product/api', agentEnvVars: ['S2_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY'] },
  { id: 'springer-nature', label: 'Springer Nature', hint: 'Metadata · full text · journals', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.springernature.com', docsUrl: 'https://dev.springernature.com', agentEnvVars: ['SPRINGER_API_KEY'] },
  { id: 'elsevier', label: 'Elsevier / ScienceDirect', hint: 'Scopus · ScienceDirect articles', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.elsevier.com', docsUrl: 'https://dev.elsevier.com', agentEnvVars: ['ELSEVIER_API_KEY'] },
  { id: 'mpds', label: 'MPDS', hint: 'Materials Platform for Data Science', integrated: true, credentialsRequired: true, settingsVisible: true, defaultBaseUrl: 'https://api.mpds.io', docsUrl: 'https://mpds.io/developer', agentEnvVars: ['MPDS_KEY'] },
  { id: 'aflow', label: 'AFLOW', hint: 'Open materials database · no key required', integrated: false, credentialsRequired: false, settingsVisible: true, defaultBaseUrl: 'https://aflowlib.duke.edu/search/API', docsUrl: 'https://aflowlib.org/API' },
  { id: 'oqmd', label: 'OQMD', hint: 'Open Quantum Materials DB · no key required', integrated: false, credentialsRequired: false, settingsVisible: true, defaultBaseUrl: 'https://oqmd.org/oqmdapi', docsUrl: 'https://static.oqmd.org/static/docs/restful.html' },
  { id: 'jarvis', label: 'JARVIS-NIST', hint: 'NIST materials datasets · no key required', integrated: false, credentialsRequired: false, settingsVisible: true, defaultBaseUrl: 'https://jarvis.nist.gov', docsUrl: 'https://pages.nist.gov/jarvis' },
  { id: 'pubchem', label: 'PubChem', hint: 'Chemical structures · properties · no key', integrated: false, credentialsRequired: false, settingsVisible: true, defaultBaseUrl: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug', docsUrl: 'https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest' },
  { id: 'crossref', label: 'Crossref', hint: 'DOI metadata · polite pool via email', integrated: false, credentialsRequired: false, settingsVisible: true, defaultBaseUrl: 'https://api.crossref.org', docsUrl: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api' },
];
