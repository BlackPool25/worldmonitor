// Sealed Company Monitoring prediction runner.
//
// Discovery capture stays outside Git. This module accepts only provider-owned
// observations that a curator already reconciled to opaque examples. It never
// sends curator reference URLs, excerpts, occurrence identities, or gold labels
// to the classifier.
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import {
  COMPANY_MONITORING_ADMISSION_POLICY_VERSION,
  evaluateCompanyMonitoringClassification,
} from '../scripts/lib/company-monitoring-classification.mjs';
import {
  normalizeCompanyEvidence,
  projectCompanyMonitoringCandidate,
  type NormalizedCompanyCandidate,
  type NormalizedCompanyEvidence,
  type ProviderEvidence,
} from './company-monitoring-evidence.ts';
import {
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computePredictionSetDigest,
  computeScoreReportDigest,
  validateBlindCorpusArtifact,
  validatePredictionSetArtifact,
  type BlindCorpus,
  type Materiality,
  type Prediction,
  type PredictionSet,
  type ScoreReport,
} from './company-monitoring-blind-evaluation.ts';
import {
  compileCompanyMonitoringBlindCorpus,
  computeCompanyMonitoringCurationManifestDigest,
  type CompanyMonitoringCurationManifest,
} from './company-monitoring-curation.ts';
import {
  canonicalJson,
  evaluateStage0,
  hasExactKeys,
  isEvidenceDigest,
  parseRfc3339Timestamp,
  validateProtocolFixture,
  type JsonObject,
} from './company-monitoring-evaluation.ts';

export type OfflineProviderCoverage = 'complete' | 'not_applicable' | 'incomplete';

export type OfflineProviderObservation = {
  provider: 'exa' | 'x';
  providerLocator: string;
  providerReceiptSha256: string;
  queryVersion: string;
  url: string;
  title: string | null;
  text: string | null;
  author: string | null;
  authorAccountId: string | null;
  officialCompanyDomain: string | null;
  publisherOrigin: string;
  syndication: {
    relationship: 'independent' | 'syndicated' | 'unknown';
    upstreamUrl: string | null;
    groupIdentity: string;
  };
  publishedAt: number;
  observedAt: number;
  expiresAt: number | null;
  sourceAuthority: 'verified_first_party' | 'independent_source' | 'low_authority';
  verifiedCompany: boolean;
};

export type OfflineProviderObservationManifest = {
  schemaVersion: 'cm_offline_provider_observations_v1';
  captureVersion: string;
  corpusVersion: string;
  corpusSha256: string;
  curationSha256: string;
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  queryVersion: string;
  capturedAt: string;
  providerQueryVersions: { exa: string; x: string };
  runtime: OfflineClassifierRuntimePin;
  custody: {
    storageClass: 'sealed_external';
    labelsVisibleToRuntime: false;
    referenceEvidenceVisibleToProviders: false;
  };
  rows: Array<{
    opaqueExampleId: string;
    coverage: { exa: OfflineProviderCoverage; x: OfflineProviderCoverage };
    providerReceipts: { exa: string | null; x: string | null };
    latencyMs: number;
    costUsd: number;
    evidence: OfflineProviderObservation[];
  }>;
};

export type OfflineClassifierRuntimePin = {
  requestedModel: string;
  providerRoute: string;
  resolvedProvider: string;
};

export type OfflineClassifierConfiguration = Omit<OfflineClassifierRuntimePin, 'resolvedProvider'>;

export type OfflineClassifierResult = {
  content: string;
  route: {
    resolvedModel: string;
    resolvedProvider: string;
    configuredProviderRoute: string;
  };
  costUsd: number;
};

export type OfflinePredictionRunReceipt = {
  schemaVersion: 'cm_offline_prediction_run_receipt_v1';
  protocolSha256: string;
  approvedThresholdDigest: string;
  corpusSha256: string;
  curationSha256: string;
  providerObservationsSha256: string;
  predictionSetSha256: string;
  protocolVersion: string;
  policyVersion: string;
  modelVersion: string;
  queryVersion: string;
  captureVersion: string;
  capturedAt: string;
  runtime: OfflineClassifierRuntimePin;
  custody: { storageClass: 'sealed_external'; labelsVisibleToRuntime: false };
};

export type OfflinePredictionBundle = {
  schemaVersion: 'cm_offline_prediction_bundle_v1';
  predictions: PredictionSet;
  receipt: OfflinePredictionRunReceipt;
  authentication: {
    algorithm: 'ed25519';
    signatureBase64: string;
  };
};

export type OfflinePredictionCheckpoint = {
  schemaVersion: 'cm_offline_prediction_checkpoint_v1';
  protocolSha256: string;
  approvedThresholdDigest: string;
  corpusSha256: string;
  curationSha256: string;
  providerObservationsSha256: string;
  runtime: OfflineClassifierRuntimePin;
  state: 'started' | 'completed';
  opaqueExampleId: string;
  prediction: Prediction | null;
  authenticationSha256: string;
};

export type OfflineContinuationAuthorization = {
  schemaVersion: 'cm_offline_continuation_authorization_v1';
  outcome: 'incomplete';
  approvedThresholdDigest: string;
  parentCorpusSha256: string;
  parentPredictionSetSha256: string;
  parentGoldLabelSetSha256: string;
  parentReportSha256: string;
  childCorpusSha256: string;
  expansionManifestSha256: string;
  signatureBase64: string;
};

export class CompanyMonitoringOfflinePredictionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CompanyMonitoringOfflinePredictionError';
    this.code = code;
  }
}

const ROOT_KEYS = new Set([
  'schemaVersion', 'captureVersion', 'corpusVersion', 'corpusSha256',
  'curationSha256', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
  'capturedAt', 'providerQueryVersions', 'runtime', 'custody', 'rows',
]);
const PROVIDER_QUERY_VERSION_KEYS = new Set(['exa', 'x']);
const RUNTIME_KEYS = new Set(['requestedModel', 'providerRoute', 'resolvedProvider']);
const CUSTODY_KEYS = new Set([
  'storageClass', 'labelsVisibleToRuntime', 'referenceEvidenceVisibleToProviders',
]);
const ROW_KEYS = new Set([
  'opaqueExampleId', 'coverage', 'providerReceipts', 'latencyMs', 'costUsd', 'evidence',
]);
const COVERAGE_KEYS = new Set(['exa', 'x']);
const PROVIDER_RECEIPT_KEYS = new Set(['exa', 'x']);
const EVIDENCE_KEYS = new Set([
  'provider', 'providerLocator', 'providerReceiptSha256', 'queryVersion', 'url',
  'title', 'text', 'author', 'authorAccountId', 'publishedAt', 'observedAt',
  'expiresAt', 'sourceAuthority', 'verifiedCompany', 'officialCompanyDomain',
  'publisherOrigin', 'syndication',
]);
const SYNDICATION_KEYS = new Set(['relationship', 'upstreamUrl', 'groupIdentity']);
const VERSION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const OPAQUE_ID = /^cm_example_[a-f0-9]{6}$/;
const COVERAGE = new Set<OfflineProviderCoverage>(['complete', 'not_applicable', 'incomplete']);
const AUTHORITY = new Set(['verified_first_party', 'independent_source', 'low_authority']);
const MAX_CLASSIFIER_CONCURRENCY = 4;
const CHECKPOINT_KEYS = new Set([
  'schemaVersion', 'protocolSha256', 'approvedThresholdDigest', 'corpusSha256',
  'curationSha256', 'providerObservationsSha256', 'runtime', 'state',
  'opaqueExampleId', 'prediction',
  'authenticationSha256',
]);
const BUNDLE_KEYS = new Set(['schemaVersion', 'predictions', 'receipt', 'authentication']);
const BUNDLE_AUTHENTICATION_KEYS = new Set(['algorithm', 'signatureBase64']);
const RECEIPT_KEYS = new Set([
  'schemaVersion', 'protocolSha256', 'approvedThresholdDigest', 'corpusSha256',
  'curationSha256', 'providerObservationsSha256', 'predictionSetSha256',
  'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
  'captureVersion', 'capturedAt', 'runtime', 'custody',
]);
const CONTINUATION_AUTHORIZATION_KEYS = new Set([
  'schemaVersion', 'outcome', 'approvedThresholdDigest', 'parentCorpusSha256',
  'parentPredictionSetSha256', 'parentGoldLabelSetSha256', 'parentReportSha256',
  'childCorpusSha256', 'expansionManifestSha256', 'signatureBase64',
]);

function fail(code: string): never {
  throw new CompanyMonitoringOfflinePredictionError(code);
}

function exact(value: unknown, keys: Set<string>, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  if (!hasExactKeys(value as JsonObject, keys)) fail(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, maximum = 2_048): string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

function nullableText(value: unknown, code: string, maximum = 32_768): string | null {
  return value === null ? null : text(value, code, maximum);
}

function finiteNonNegative(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function safeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function version(value: unknown, code: string): string {
  const result = text(value, code, 200);
  if (!VERSION.test(result)) fail(code);
  return result;
}

function httpsUrl(value: unknown, code: string): string {
  const result = text(value, code);
  try {
    const url = new URL(result);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(code);
  } catch {
    fail(code);
  }
  return result;
}

function officialDomain(value: unknown, code: string): string | null {
  if (value === null) return null;
  const result = text(value, code, 253);
  if (result !== result.toLowerCase()) fail(code);
  try {
    const url = new URL(`https://${result}`);
    if (url.hostname !== result || url.port || url.pathname !== '/' || !result.includes('.')) fail(code);
  } catch {
    fail(code);
  }
  return result;
}

function validateObservation(value: unknown): OfflineProviderObservation {
  const row = exact(value, EVIDENCE_KEYS, 'offline_observation_field_forbidden');
  if (row.provider !== 'exa' && row.provider !== 'x') fail('offline_observation_provider_invalid');
  text(row.providerLocator, 'offline_observation_locator_invalid');
  if (!isEvidenceDigest(row.providerReceiptSha256)) fail('offline_observation_receipt_digest_invalid');
  version(row.queryVersion, 'offline_observation_query_version_invalid');
  const url = httpsUrl(row.url, 'offline_observation_url_invalid');
  nullableText(row.title, 'offline_observation_title_invalid', 512);
  nullableText(row.text, 'offline_observation_text_invalid');
  nullableText(row.author, 'offline_observation_author_invalid', 256);
  nullableText(row.authorAccountId, 'offline_observation_author_id_invalid', 256);
  const companyDomain = officialDomain(
    row.officialCompanyDomain,
    'offline_observation_official_domain_invalid',
  );
  const publisherOrigin = text(row.publisherOrigin, 'offline_observation_publisher_origin_invalid', 253);
  const urlOrigin = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const expectedPublisherOrigin = row.provider === 'x' ? row.authorAccountId : urlOrigin;
  if (expectedPublisherOrigin === null || publisherOrigin !== expectedPublisherOrigin) {
    fail('offline_observation_publisher_origin_mismatch');
  }
  const syndication = exact(
    row.syndication,
    SYNDICATION_KEYS,
    'offline_observation_syndication_forbidden',
  );
  if (!['independent', 'syndicated', 'unknown'].includes(String(syndication.relationship))) {
    fail('offline_observation_syndication_invalid');
  }
  nullableText(syndication.upstreamUrl, 'offline_observation_upstream_url_invalid');
  if (syndication.upstreamUrl !== null) httpsUrl(syndication.upstreamUrl, 'offline_observation_upstream_url_invalid');
  text(syndication.groupIdentity, 'offline_observation_syndication_group_invalid', 512);
  if (
    (syndication.relationship === 'syndicated') !== (syndication.upstreamUrl !== null)
  ) fail('offline_observation_syndication_invalid');
  const publishedAt = safeInteger(row.publishedAt, 'offline_observation_published_at_invalid');
  const observedAt = safeInteger(row.observedAt, 'offline_observation_observed_at_invalid');
  if (publishedAt > observedAt) fail('offline_observation_time_order_invalid');
  if (row.expiresAt !== null) {
    const expiresAt = safeInteger(row.expiresAt, 'offline_observation_expiry_invalid');
    if (expiresAt <= observedAt) fail('offline_observation_expiry_invalid');
  }
  if (!AUTHORITY.has(String(row.sourceAuthority))) fail('offline_observation_authority_invalid');
  if (typeof row.verifiedCompany !== 'boolean') fail('offline_observation_verification_invalid');
  if (row.verifiedCompany) {
    if (row.sourceAuthority !== 'verified_first_party') fail('offline_observation_verification_invalid');
    if (row.provider === 'x' && (row.authorAccountId === null || companyDomain !== null)) {
      fail('offline_observation_verification_invalid');
    }
    if (row.provider === 'exa') {
      const hostname = new URL(url).hostname.toLowerCase();
      if (
        companyDomain === null || row.authorAccountId !== null ||
        (hostname !== companyDomain && !hostname.endsWith(`.${companyDomain}`))
      ) fail('offline_observation_verification_invalid');
    }
  } else if (companyDomain !== null || (row.provider === 'exa' && row.sourceAuthority === 'verified_first_party')) {
    fail('offline_observation_verification_invalid');
  }
  return row as OfflineProviderObservation;
}

function validateManifest(
  value: unknown,
  corpus: BlindCorpus,
): OfflineProviderObservationManifest {
  const manifest = exact(value, ROOT_KEYS, 'offline_manifest_field_forbidden');
  if (manifest.schemaVersion !== 'cm_offline_provider_observations_v1') {
    fail('offline_manifest_schema_invalid');
  }
  version(manifest.captureVersion, 'offline_capture_version_invalid');
  for (const field of ['corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion'] as const) {
    version(manifest[field], `offline_${field}_invalid`);
    if (manifest[field] !== corpus[field]) fail(`offline_${field}_mismatch`);
  }
  if (manifest.corpusSha256 !== computeBlindCorpusDigest(corpus)) fail('offline_corpus_digest_mismatch');
  if (!isEvidenceDigest(manifest.curationSha256)) fail('offline_curation_digest_invalid');
  const capturedAt = parseRfc3339Timestamp(manifest.capturedAt);
  if (capturedAt === null) fail('offline_capture_timestamp_invalid');

  const providerQueryVersions = exact(
    manifest.providerQueryVersions,
    PROVIDER_QUERY_VERSION_KEYS,
    'offline_provider_query_versions_forbidden',
  );
  for (const provider of ['exa', 'x'] as const) {
    version(providerQueryVersions[provider], 'offline_provider_query_version_invalid');
  }

  const runtime = exact(manifest.runtime, RUNTIME_KEYS, 'offline_runtime_field_forbidden');
  text(runtime.requestedModel, 'offline_runtime_model_invalid', 200);
  text(runtime.providerRoute, 'offline_runtime_provider_invalid', 200);
  text(runtime.resolvedProvider, 'offline_runtime_provider_invalid', 200);
  const custody = exact(manifest.custody, CUSTODY_KEYS, 'offline_custody_field_forbidden');
  if (
    custody.storageClass !== 'sealed_external' || custody.labelsVisibleToRuntime !== false ||
    custody.referenceEvidenceVisibleToProviders !== false
  ) fail('offline_custody_boundary_invalid');
  if (!Array.isArray(manifest.rows)) fail('offline_rows_invalid');

  const exampleIds = new Set(corpus.examples.map((example) => example.opaqueExampleId));
  const seenExamples = new Set<string>();
  const seenLocators = new Set<string>();
  for (const value of manifest.rows) {
    const row = exact(value, ROW_KEYS, 'offline_row_field_forbidden');
    const opaqueId = text(row.opaqueExampleId, 'offline_example_id_invalid', 40);
    if (!OPAQUE_ID.test(opaqueId) || !exampleIds.has(opaqueId) || seenExamples.has(opaqueId)) {
      fail('offline_example_membership_invalid');
    }
    seenExamples.add(opaqueId);
    const coverage = exact(row.coverage, COVERAGE_KEYS, 'offline_coverage_field_forbidden');
    const providerReceipts = exact(
      row.providerReceipts,
      PROVIDER_RECEIPT_KEYS,
      'offline_provider_receipts_forbidden',
    );
    for (const provider of ['exa', 'x'] as const) {
      if (!COVERAGE.has(coverage[provider] as OfflineProviderCoverage)) {
        fail('offline_coverage_status_invalid');
      }
      if (coverage[provider] === 'incomplete') fail('offline_provider_coverage_incomplete');
      if (
        (coverage[provider] === 'complete' && !isEvidenceDigest(providerReceipts[provider])) ||
        (coverage[provider] === 'not_applicable' && providerReceipts[provider] !== null)
      ) fail('offline_provider_receipt_invalid');
    }
    if (coverage.exa !== 'complete') fail('offline_exa_coverage_required');
    finiteNonNegative(row.latencyMs, 'offline_latency_invalid');
    finiteNonNegative(row.costUsd, 'offline_cost_invalid');
    if (!Array.isArray(row.evidence)) fail('offline_evidence_invalid');
    for (const evidenceValue of row.evidence) {
      const evidence = validateObservation(evidenceValue);
      if (coverage[evidence.provider] !== 'complete') fail('offline_evidence_without_coverage');
      if (evidence.queryVersion !== providerQueryVersions[evidence.provider]) {
        fail('offline_observation_query_version_mismatch');
      }
      if (evidence.observedAt > capturedAt) fail('offline_observation_after_capture');
      const locatorKey = `${evidence.provider}\u0000${evidence.providerLocator}`;
      if (seenLocators.has(locatorKey)) fail('offline_observation_reused');
      seenLocators.add(locatorKey);
    }
  }
  if (seenExamples.size !== exampleIds.size) fail('offline_prediction_denominator_incomplete');
  return manifest as OfflineProviderObservationManifest;
}

export function assertCompanyMonitoringOfflineRuntimePermitted(
  protocol: JsonObject,
  approvedThresholdDigest: string,
): void {
  try {
    validateProtocolFixture(protocol);
  } catch {
    fail('offline_protocol_schema_invalid');
  }
  const result = evaluateStage0(protocol, { approvedThresholdDigest });
  if (result.decision !== 'continue') fail('offline_runtime_protocol_stop');
}

function assertCurationMatchesCorpus(
  curation: CompanyMonitoringCurationManifest,
  corpus: BlindCorpus,
): Map<string, CompanyMonitoringCurationManifest['candidates'][number]> {
  validateBlindCorpusArtifact(corpus);
  if (corpus.status !== 'locked') fail('offline_corpus_not_locked');
  if (corpus.sealedGoldLabelsSha256 === null) fail('offline_sealed_gold_digest_missing');
  if (corpus.policyVersion !== COMPANY_MONITORING_ADMISSION_POLICY_VERSION) {
    fail('offline_policy_version_mismatch');
  }
  let compiled;
  try {
    compiled = compileCompanyMonitoringBlindCorpus(curation).corpus;
  } catch {
    fail('offline_curation_invalid');
  }
  for (const field of [
    'corpusVersion', 'purpose', 'protocolVersion', 'policyVersion', 'modelVersion',
    'queryVersion', 'curatorAccessVersion',
  ] as const) {
    if (compiled[field] !== corpus[field]) fail('offline_curation_corpus_mismatch');
  }
  if (canonicalJson(compiled.examples) !== canonicalJson(corpus.examples)) {
    fail('offline_curation_corpus_mismatch');
  }
  return new Map(curation.candidates.flatMap((candidate) =>
    candidate.disposition === 'included' && candidate.opaqueExampleId
      ? [[candidate.opaqueExampleId, candidate] as const]
      : []
  ));
}

function companyIdFor(opaqueExampleId: string): string {
  return `cm_eval_company_${opaqueExampleId.slice('cm_example_'.length)}`;
}

function providerEvidence(
  observation: OfflineProviderObservation,
  companyId: string,
): ProviderEvidence {
  return {
    provider: observation.provider,
    providerLocator: observation.providerLocator,
    queryVersion: observation.queryVersion,
    url: observation.url,
    ...(observation.title === null ? {} : { title: observation.title }),
    ...(observation.text === null ? {} : { text: observation.text }),
    ...(observation.author === null ? {} : { author: observation.author }),
    ...(observation.authorAccountId === null ? {} : { authorAccountId: observation.authorAccountId }),
    publishedAt: observation.publishedAt,
    observedAt: observation.observedAt,
    ...(observation.expiresAt === null ? {} : { expiresAt: observation.expiresAt }),
    candidateCompanyIds: [companyId],
    ...(observation.verifiedCompany ? { verifiedCompanyIds: [companyId] } : {}),
    sourceAuthority: observation.sourceAuthority,
  };
}

async function normalizedEvaluationEvidence(
  opaqueExampleId: string,
  legalName: string,
  observations: OfflineProviderObservation[],
  capturedAt: number,
  occurrenceDigest: string,
): Promise<NormalizedCompanyEvidence[]> {
  const companyId = companyIdFor(opaqueExampleId);
  const officialDomains = [...new Set(observations.flatMap((observation) =>
    observation.officialCompanyDomain === null ? [] : [observation.officialCompanyDomain]
  ))].sort();
  const normalized = await normalizeCompanyEvidence({
    ownerAccountId: 'cm_eval_account',
    subjects: [{
      companyId,
      name: legalName,
      claims: [{
        claimId: 'cm_eval_legal_name',
        type: 'alias',
        value: legalName,
        trustState: 'verified',
        allowedUses: ['discovery', 'attribution'],
      }, ...officialDomains.map((domain, index) => ({
        claimId: `cm_eval_official_domain_${index + 1}`,
        type: 'domain' as const,
        value: domain,
        trustState: 'verified' as const,
        allowedUses: ['discovery', 'attribution'] as const,
      }))],
    }],
    evidence: observations.map((observation) => providerEvidence(observation, companyId)),
    now: capturedAt,
  });
  const observationByLocator = new Map(observations.map((observation) => [
    `${observation.provider}\u0000${observation.providerLocator}`,
    observation,
  ]));
  const groupOrigins = new Map<string, Set<string>>();
  for (const evidence of normalized.evidence) {
    const observation = observationByLocator.get(`${evidence.provider}\u0000${evidence.providerLocator}`)!;
    if (observation.syndication.relationship !== 'independent') continue;
    const origins = groupOrigins.get(observation.syndication.groupIdentity) ?? new Set<string>();
    origins.add(observation.publisherOrigin);
    groupOrigins.set(observation.syndication.groupIdentity, origins);
  }
  return normalized.evidence.map((evidence) => {
    const observation = observationByLocator.get(`${evidence.provider}\u0000${evidence.providerLocator}`)!;
    const independence = evidence.independence === 'first_party'
      ? 'first_party'
      : observation.syndication.relationship === 'independent' &&
          groupOrigins.get(observation.syndication.groupIdentity)?.size === 1
        ? 'independent'
        : observation.syndication.relationship === 'syndicated'
          ? 'syndicated'
          : 'unknown';
    return { ...evidence, independence, occurrenceDedupeKey: occurrenceDigest };
  });
}

function emptyPrediction(
  opaqueExampleId: string,
  discovered: boolean,
  latencyMs: number,
  costUsd: number,
): Prediction {
  return {
    opaqueExampleId,
    discovered,
    publish: false,
    predictedMateriality: 'immaterial',
    predictedDirection: null,
    attributedCorporateFamilyDigest: null,
    confidence: 0,
    latencyMs,
    costUsd,
  };
}

export async function runCompanyMonitoringOfflinePredictions(input: {
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  expectedCurationSha256?: string;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  expectedObservationsSha256?: string;
  runtime: OfflineClassifierConfiguration;
  previous?: {
    corpus: BlindCorpus;
    expectedCorpusSha256: string;
    predictions: PredictionSet;
    expectedPredictionSetSha256: string;
    report: ScoreReport;
    expectedReportSha256: string;
    authorization: OfflineContinuationAuthorization;
    authorizationPublicKeyPem: string;
  };
  checkpoints?: OfflinePredictionCheckpoint[];
  checkpointAuthenticationKey?: string;
  onCheckpoint?: (checkpoint: OfflinePredictionCheckpoint) => Promise<void> | void;
  classify: (input: {
    candidate: NormalizedCompanyCandidate;
    evidence: NormalizedCompanyEvidence[];
  }) => Promise<OfflineClassifierResult>;
  monotonicNow?: () => number;
}): Promise<PredictionSet> {
  assertCompanyMonitoringOfflineRuntimePermitted(input.protocol, input.approvedThresholdDigest);
  const curationById = assertCurationMatchesCorpus(input.curation, input.corpus);
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  if (
    !isEvidenceDigest(input.expectedCurationSha256) ||
    curationSha256 !== input.expectedCurationSha256
  ) fail('offline_curation_digest_mismatch');
  const observations = validateManifest(input.observations, input.corpus);
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  const protocolSha256 = createHash('sha256').update(canonicalJson(input.protocol)).digest('hex');
  const providerObservationsSha256 = computeOfflineProviderObservationDigest(
    observations,
    input.corpus,
  );
  if (observations.curationSha256 !== curationSha256) fail('offline_observation_curation_mismatch');
  if (
    !isEvidenceDigest(input.expectedObservationsSha256) ||
    providerObservationsSha256 !== input.expectedObservationsSha256
  ) fail('offline_observation_digest_mismatch');
  if (
    input.runtime.requestedModel !== observations.runtime.requestedModel ||
    input.runtime.providerRoute !== observations.runtime.providerRoute
  ) fail('offline_classifier_configuration_mismatch');
  const capturedAt = parseRfc3339Timestamp(observations.capturedAt)!;
  const rows = new Map(observations.rows.map((row) => [row.opaqueExampleId, row]));
  const examples = new Map(input.corpus.examples.map((example) => [example.opaqueExampleId, example]));
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const predictions = input.previous
    ? validatePreviousPredictions(input.corpus, input.previous, input.approvedThresholdDigest)
    : new Map<string, Prediction>();
  const opaqueExampleIds = [...examples.keys()].sort();
  const checkpointAuthenticationKey = text(
    input.checkpointAuthenticationKey,
    'offline_checkpoint_authentication_missing',
    1_024,
  );
  const authenticateCheckpoint = (
    checkpoint: Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>,
  ): string => createHmac('sha256', checkpointAuthenticationKey)
    .update(canonicalJson(checkpoint))
    .digest('hex');
  const completedCheckpointIds = new Set((input.checkpoints ?? []).flatMap((checkpoint) =>
    checkpoint.state === 'completed' ? [checkpoint.opaqueExampleId] : []
  ));
  for (const checkpointValue of input.checkpoints ?? []) {
    const checkpoint = exact(
      checkpointValue,
      CHECKPOINT_KEYS,
      'offline_checkpoint_field_forbidden',
    ) as OfflinePredictionCheckpoint;
    if (!isEvidenceDigest(checkpoint.authenticationSha256)) fail('offline_checkpoint_authentication_invalid');
    const { authenticationSha256, ...checkpointBody } = checkpoint;
    const expectedAuthentication = authenticateCheckpoint(checkpointBody);
    if (!timingSafeEqual(Buffer.from(authenticationSha256), Buffer.from(expectedAuthentication))) {
      fail('offline_checkpoint_authentication_invalid');
    }
    if (
      checkpoint.schemaVersion !== 'cm_offline_prediction_checkpoint_v1' ||
      checkpoint.protocolSha256 !== protocolSha256 ||
      checkpoint.approvedThresholdDigest !== input.approvedThresholdDigest ||
      checkpoint.corpusSha256 !== corpusSha256 ||
      checkpoint.curationSha256 !== curationSha256 ||
      checkpoint.providerObservationsSha256 !== providerObservationsSha256 ||
      canonicalJson(checkpoint.runtime) !== canonicalJson(observations.runtime)
    ) fail('offline_checkpoint_anchor_mismatch');
    if (!examples.has(checkpoint.opaqueExampleId)) fail('offline_checkpoint_membership_invalid');
    if (checkpoint.state === 'started') {
      if (checkpoint.prediction !== null) fail('offline_checkpoint_state_invalid');
      if (completedCheckpointIds.has(checkpoint.opaqueExampleId)) continue;
      fail('offline_checkpoint_reconciliation_required');
    }
    if (
      checkpoint.state !== 'completed' || checkpoint.prediction === null ||
      checkpoint.prediction.opaqueExampleId !== checkpoint.opaqueExampleId
    ) fail('offline_checkpoint_state_invalid');
    validatePredictionSetArtifact({
      schemaVersion: 'cm_predictions_v1',
      corpusVersion: input.corpus.corpusVersion,
      corpusSha256: checkpoint.corpusSha256,
      protocolVersion: input.corpus.protocolVersion,
      policyVersion: input.corpus.policyVersion,
      modelVersion: input.corpus.modelVersion,
      queryVersion: input.corpus.queryVersion,
      parentPredictionSetSha256: input.previous
        ? computePredictionSetDigest(input.previous.predictions)
        : null,
      parentGoldLabelSetSha256: input.previous
        ? input.previous.corpus.sealedGoldLabelsSha256
        : null,
      predictions: [checkpoint.prediction],
    });
    if (
      predictions.has(checkpoint.opaqueExampleId)
    ) fail('offline_checkpoint_membership_invalid');
    predictions.set(checkpoint.opaqueExampleId, checkpoint.prediction);
  }
  const pendingExampleIds = opaqueExampleIds.filter((opaqueExampleId) => !predictions.has(opaqueExampleId));

  const predict = async (opaqueExampleId: string): Promise<Prediction> => {
    const example = examples.get(opaqueExampleId)!;
    const row = rows.get(opaqueExampleId)!;
    if (row.evidence.length === 0) {
      return emptyPrediction(opaqueExampleId, false, row.latencyMs, row.costUsd);
    }
    const curatorCandidate = curationById.get(opaqueExampleId);
    if (!curatorCandidate) fail('offline_curation_membership_mismatch');
    const evidence = await normalizedEvaluationEvidence(
      opaqueExampleId,
      curatorCandidate.company.legalName,
      row.evidence,
      capturedAt,
      example.occurrenceDigest,
    );
    if (evidence.length === 0) {
      return emptyPrediction(opaqueExampleId, true, row.latencyMs, row.costUsd);
    }
    const candidate = projectCompanyMonitoringCandidate(evidence, example.occurrenceDigest);
    const startedAt = monotonicNow();
    const classification = await input.classify({ candidate, evidence });
    const completedAt = monotonicNow();
    if (
      classification.route.resolvedModel !== observations.runtime.requestedModel ||
      classification.route.configuredProviderRoute !== observations.runtime.providerRoute ||
      classification.route.resolvedProvider !== observations.runtime.resolvedProvider ||
      typeof classification.content !== 'string' ||
      !Number.isFinite(classification.costUsd) || classification.costUsd < 0
    ) fail('offline_classifier_runtime_mismatch');
    const policy = evaluateCompanyMonitoringClassification({
      candidate,
      evidence,
      modelOutput: classification.content,
      now: Math.max(...evidence.map((item) => item.observedAt)),
      modelVersion: input.corpus.modelVersion,
    });
    const materiality: Materiality = policy.classification?.materiality.truth === 'material'
      ? 'material'
      : 'immaterial';
    return {
      opaqueExampleId,
      discovered: true,
      publish: policy.decision === 'publish',
      predictedMateriality: materiality,
      predictedDirection: policy.classification?.direction ?? null,
      attributedCorporateFamilyDigest:
        policy.classification?.attribution.truth === 'confirmed'
          ? example.corporateFamilyDigest
          : null,
      confidence: policy.overallConfidence ?? 0,
      latencyMs: row.latencyMs + Math.max(0, completedAt - startedAt),
      costUsd: row.costUsd + classification.costUsd,
    };
  };

  let cursor = 0;
  let stopped = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = cursor;
      if (index >= pendingExampleIds.length) return;
      cursor += 1;
      const opaqueExampleId = pendingExampleIds[index]!;
      try {
        const startedCheckpoint = {
          schemaVersion: 'cm_offline_prediction_checkpoint_v1',
          protocolSha256,
          approvedThresholdDigest: input.approvedThresholdDigest,
          corpusSha256,
          curationSha256,
          providerObservationsSha256,
          runtime: observations.runtime,
          state: 'started',
          opaqueExampleId,
          prediction: null,
        } satisfies Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>;
        await input.onCheckpoint?.({
          ...startedCheckpoint,
          authenticationSha256: authenticateCheckpoint(startedCheckpoint),
        });
        const prediction = await predict(opaqueExampleId);
        const completedCheckpoint = {
          schemaVersion: 'cm_offline_prediction_checkpoint_v1',
          protocolSha256,
          approvedThresholdDigest: input.approvedThresholdDigest,
          corpusSha256,
          curationSha256,
          providerObservationsSha256,
          runtime: observations.runtime,
          state: 'completed',
          opaqueExampleId,
          prediction,
        } satisfies Omit<OfflinePredictionCheckpoint, 'authenticationSha256'>;
        await input.onCheckpoint?.({
          ...completedCheckpoint,
          authenticationSha256: authenticateCheckpoint(completedCheckpoint),
        });
        predictions.set(opaqueExampleId, prediction);
      } catch (error) {
        if (!stopped) failure = error;
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CLASSIFIER_CONCURRENCY, pendingExampleIds.length) },
    () => worker(),
  ));
  if (stopped) throw failure;

  const predictionSet: PredictionSet = {
    schemaVersion: 'cm_predictions_v1',
    corpusVersion: input.corpus.corpusVersion,
    corpusSha256,
    protocolVersion: input.corpus.protocolVersion,
    policyVersion: input.corpus.policyVersion,
    modelVersion: input.corpus.modelVersion,
    queryVersion: input.corpus.queryVersion,
    parentPredictionSetSha256: input.previous
      ? computePredictionSetDigest(input.previous.predictions)
      : null,
    parentGoldLabelSetSha256: input.previous
      ? input.previous.corpus.sealedGoldLabelsSha256
      : null,
    predictions: opaqueExampleIds.map((opaqueExampleId) => predictions.get(opaqueExampleId)!),
  };
  validatePredictionSetArtifact(predictionSet);
  return predictionSet;
}

function validatePreviousPredictions(
  corpus: BlindCorpus,
  previous: NonNullable<Parameters<typeof runCompanyMonitoringOfflinePredictions>[0]['previous']>,
  approvedThresholdDigest: string,
): Map<string, Prediction> {
  validateBlindCorpusArtifact(previous.corpus);
  validatePredictionSetArtifact(previous.predictions);
  if (
    !isEvidenceDigest(previous.expectedCorpusSha256) ||
    computeBlindCorpusDigest(previous.corpus) !== previous.expectedCorpusSha256 ||
    !isEvidenceDigest(previous.expectedPredictionSetSha256) ||
    computePredictionSetDigest(previous.predictions) !== previous.expectedPredictionSetSha256 ||
    previous.report.schemaVersion !== 'cm_blind_score_report_v1' ||
    previous.report.outcome !== 'incomplete' ||
    !isEvidenceDigest(previous.expectedReportSha256) ||
    previous.report.reportSha256 !== previous.expectedReportSha256 ||
    computeScoreReportDigest(previous.report) !== previous.report.reportSha256 ||
    previous.report.corpus.version !== previous.corpus.corpusVersion ||
    previous.report.corpus.sha256 !== previous.expectedCorpusSha256 ||
    previous.report.predictionSetSha256 !== previous.expectedPredictionSetSha256 ||
    previous.report.goldLabelSetSha256 !== previous.corpus.sealedGoldLabelsSha256 ||
    previous.report.protocol.version !== previous.corpus.protocolVersion ||
    previous.report.protocol.approvedThresholdsSha256 !== approvedThresholdDigest ||
    previous.report.corpus.purpose !== previous.corpus.purpose ||
    previous.report.corpus.exampleCount !== previous.corpus.examples.length ||
    previous.report.versions.policyVersion !== previous.corpus.policyVersion ||
    previous.report.versions.modelVersion !== previous.corpus.modelVersion ||
    previous.report.versions.queryVersion !== previous.corpus.queryVersion ||
    previous.report.versions.curatorAccessVersion !== previous.corpus.curatorAccessVersion ||
    previous.corpus.status !== 'locked' ||
    previous.corpus.sealedGoldLabelsSha256 === null ||
    previous.corpus.precommittedExpansion === null
  ) fail('offline_previous_corpus_invalid');
  for (const field of [
    'purpose', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
    'curatorAccessVersion',
  ] as const) {
    if (corpus[field] !== previous.corpus[field]) fail('offline_continuation_version_mismatch');
  }
  const continuation = corpus.continuation;
  if (
    continuation === null ||
    continuation.parentCorpusVersion !== previous.corpus.corpusVersion ||
    continuation.parentCorpusSha256 !== previous.expectedCorpusSha256 ||
    continuation.parentReportSha256 !== previous.expectedReportSha256
  ) fail('offline_continuation_parent_mismatch');
  for (let index = 0; index < previous.corpus.examples.length; index += 1) {
    if (canonicalJson(corpus.examples[index]) !== canonicalJson(previous.corpus.examples[index])) {
      fail('offline_continuation_changed_example');
    }
  }
  const appended = corpus.examples.slice(previous.corpus.examples.length);
  if (
    appended.length !== previous.corpus.precommittedExpansion.exampleCount ||
    computeExpansionManifestDigest(appended) !== previous.corpus.precommittedExpansion.manifestSha256
  ) fail('offline_continuation_expansion_mismatch');
  const authorization = exact(
    previous.authorization,
    CONTINUATION_AUTHORIZATION_KEYS,
    'offline_continuation_authorization_invalid',
  ) as OfflineContinuationAuthorization;
  const { signatureBase64, ...authorizationBody } = authorization;
  if (
    authorization.schemaVersion !== 'cm_offline_continuation_authorization_v1' ||
    authorization.outcome !== 'incomplete' ||
    authorization.approvedThresholdDigest !== approvedThresholdDigest ||
    authorization.parentCorpusSha256 !== previous.expectedCorpusSha256 ||
    authorization.parentPredictionSetSha256 !== previous.expectedPredictionSetSha256 ||
    authorization.parentGoldLabelSetSha256 !== previous.corpus.sealedGoldLabelsSha256 ||
    authorization.parentReportSha256 !== previous.expectedReportSha256 ||
    authorization.childCorpusSha256 !== computeBlindCorpusDigest(corpus) ||
    authorization.expansionManifestSha256 !== previous.corpus.precommittedExpansion.manifestSha256 ||
    typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)
  ) fail('offline_continuation_authorization_invalid');
  try {
    const publicKey = createPublicKey(previous.authorizationPublicKeyPem);
    const valid = verify(
      null,
      Buffer.from(canonicalJson(authorizationBody)),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
    if (!valid) fail('offline_continuation_authorization_invalid');
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_continuation_authorization_invalid');
  }
  for (const field of ['corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion'] as const) {
    const expected = field === 'corpusVersion'
      ? previous.corpus.corpusVersion
      : previous.corpus[field];
    if (previous.predictions[field] !== expected) fail('offline_previous_predictions_mismatch');
  }
  if (previous.predictions.corpusSha256 !== previous.expectedCorpusSha256) {
    fail('offline_previous_predictions_mismatch');
  }
  const previousExampleIds = new Set(previous.corpus.examples.map((example) => example.opaqueExampleId));
  if (
    previous.predictions.predictions.length !== previousExampleIds.size ||
    previous.predictions.predictions.some((prediction) => !previousExampleIds.has(prediction.opaqueExampleId))
  ) fail('offline_previous_predictions_mismatch');
  return new Map(previous.predictions.predictions.map((prediction) => [prediction.opaqueExampleId, prediction]));
}

export function computeOfflineProviderObservationDigest(
  observations: OfflineProviderObservationManifest,
  corpus: BlindCorpus,
): string {
  validateManifest(observations, corpus);
  return createHash('sha256').update(canonicalJson(observations)).digest('hex');
}

export function createOfflinePredictionRunReceipt(input: {
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  predictions: PredictionSet;
}): OfflinePredictionRunReceipt {
  assertCompanyMonitoringOfflineRuntimePermitted(input.protocol, input.approvedThresholdDigest);
  validatePredictionSetArtifact(input.predictions);
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  const providerObservationsSha256 = computeOfflineProviderObservationDigest(
    input.observations,
    input.corpus,
  );
  if (
    input.predictions.corpusSha256 !== corpusSha256 ||
    input.observations.curationSha256 !== curationSha256
  ) fail('offline_prediction_receipt_input_mismatch');
  return {
    schemaVersion: 'cm_offline_prediction_run_receipt_v1',
    protocolSha256: createHash('sha256').update(canonicalJson(input.protocol)).digest('hex'),
    approvedThresholdDigest: input.approvedThresholdDigest,
    corpusSha256,
    curationSha256,
    providerObservationsSha256,
    predictionSetSha256: computePredictionSetDigest(input.predictions),
    protocolVersion: input.corpus.protocolVersion,
    policyVersion: input.corpus.policyVersion,
    modelVersion: input.corpus.modelVersion,
    queryVersion: input.corpus.queryVersion,
    captureVersion: input.observations.captureVersion,
    capturedAt: input.observations.capturedAt,
    runtime: input.observations.runtime,
    custody: { storageClass: 'sealed_external', labelsVisibleToRuntime: false },
  };
}

export function createOfflinePredictionBundle(input: {
  predictions: PredictionSet;
  receipt: OfflinePredictionRunReceipt;
  signingPrivateKeyPem: string;
}): OfflinePredictionBundle {
  const body = {
    schemaVersion: 'cm_offline_prediction_bundle_v1' as const,
    predictions: input.predictions,
    receipt: input.receipt,
  };
  try {
    const privateKey = createPrivateKey(input.signingPrivateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('offline_bundle_signing_key_invalid');
    return {
      ...body,
      authentication: {
        algorithm: 'ed25519',
        signatureBase64: sign(
          null,
          Buffer.from(canonicalJson(body)),
          privateKey,
        ).toString('base64'),
      },
    };
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_bundle_signing_key_invalid');
  }
}

export function validateOfflinePredictionBundle(input: {
  bundle: unknown;
  verificationPublicKeyPem: string;
  protocol: JsonObject;
  approvedThresholdDigest: string;
  curation: CompanyMonitoringCurationManifest;
  expectedCurationSha256: string;
  corpus: BlindCorpus;
  observations: OfflineProviderObservationManifest;
  expectedObservationsSha256: string;
}): PredictionSet {
  const bundle = exact(input.bundle, BUNDLE_KEYS, 'offline_prediction_bundle_invalid');
  if (bundle.schemaVersion !== 'cm_offline_prediction_bundle_v1') {
    fail('offline_prediction_bundle_invalid');
  }
  const authentication = exact(
    bundle.authentication,
    BUNDLE_AUTHENTICATION_KEYS,
    'offline_prediction_bundle_invalid',
  );
  if (authentication.algorithm !== 'ed25519' || typeof authentication.signatureBase64 !== 'string') {
    fail('offline_prediction_bundle_invalid');
  }
  const signature = Buffer.from(authentication.signatureBase64, 'base64');
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== authentication.signatureBase64
  ) fail('offline_prediction_bundle_invalid');
  try {
    const publicKey = createPublicKey(input.verificationPublicKeyPem);
    const body = {
      schemaVersion: bundle.schemaVersion,
      predictions: bundle.predictions,
      receipt: bundle.receipt,
    };
    if (
      publicKey.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(canonicalJson(body)), publicKey, signature)
    ) fail('offline_prediction_bundle_invalid');
  } catch (error) {
    if (error instanceof CompanyMonitoringOfflinePredictionError) throw error;
    fail('offline_prediction_bundle_invalid');
  }
  validatePredictionSetArtifact(bundle.predictions);
  const predictions = bundle.predictions as PredictionSet;
  const corpusSha256 = computeBlindCorpusDigest(input.corpus);
  for (const field of [
    'corpusVersion', 'protocolVersion', 'policyVersion', 'modelVersion', 'queryVersion',
  ] as const) {
    if (predictions[field] !== input.corpus[field]) fail('offline_prediction_bundle_invalid');
  }
  const exampleIds = new Set(input.corpus.examples.map((example) => example.opaqueExampleId));
  if (
    predictions.corpusSha256 !== corpusSha256 ||
    predictions.predictions.length !== exampleIds.size ||
    new Set(predictions.predictions.map((prediction) => prediction.opaqueExampleId)).size !== exampleIds.size ||
    predictions.predictions.some((prediction) => !exampleIds.has(prediction.opaqueExampleId))
  ) fail('offline_prediction_bundle_invalid');
  const receipt = exact(bundle.receipt, RECEIPT_KEYS, 'offline_prediction_bundle_invalid');
  const curationSha256 = computeCompanyMonitoringCurationManifestDigest(input.curation);
  if (curationSha256 !== input.expectedCurationSha256) fail('offline_prediction_bundle_invalid');
  const observationsSha256 = computeOfflineProviderObservationDigest(input.observations, input.corpus);
  if (observationsSha256 !== input.expectedObservationsSha256) fail('offline_prediction_bundle_invalid');
  const expectedReceipt = createOfflinePredictionRunReceipt({
    protocol: input.protocol,
    approvedThresholdDigest: input.approvedThresholdDigest,
    curation: input.curation,
    corpus: input.corpus,
    observations: input.observations,
    predictions,
  });
  if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
    fail('offline_prediction_bundle_invalid');
  }
  return predictions;
}
