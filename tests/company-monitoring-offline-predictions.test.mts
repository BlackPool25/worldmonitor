import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CompanyMonitoringOfflinePredictionError,
  computeOfflineProviderObservationDigest,
  createOfflinePredictionBundle,
  createOfflinePredictionRunReceipt,
  runCompanyMonitoringOfflinePredictions,
  validateOfflinePredictionBundle,
  type OfflineProviderObservationManifest,
  type OfflinePredictionCheckpoint,
  type OfflineContinuationAuthorization,
} from '../shared/company-monitoring-offline-predictions.ts';
import {
  compileCompanyMonitoringBlindCorpus,
  computeCompanyMonitoringCurationManifestDigest,
  type CompanyMonitoringCurationManifest,
} from '../shared/company-monitoring-curation.ts';
import {
  asNumber,
  asObject,
  canonicalJson,
  exactBinomialLowerBound,
  exactPoissonRateLowerBound,
  syntheticDigest,
  type JsonObject,
} from '../shared/company-monitoring-evaluation.ts';
import {
  computeBlindCorpusDigest,
  computeExpansionManifestDigest,
  computePredictionSetDigest,
  computeScoreReportDigest,
  type BlindCorpus,
  type ScoreReport,
} from '../shared/company-monitoring-blind-evaluation.ts';

const approvedThresholdDigest = '29ce1d431086f3b7a9a955776f0c2c009d87c809f810f32f8b10aef53f8ecfc2';
const checkpointAuthenticationKey = 'test-only-checkpoint-authentication-key';
const bundleKeys = generateKeyPairSync('ed25519');
const bundleSigningPrivateKeyPem = bundleKeys.privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}).toString();
const bundleVerificationPublicKeyPem = bundleKeys.publicKey.export({
  type: 'spki',
  format: 'pem',
}).toString();
const protocol = JSON.parse(readFileSync(
  new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url),
  'utf8',
)) as JsonObject;

function completeUsefulness(candidate: JsonObject): void {
  const directions = ['positive', 'negative', 'mixed'];
  const impacts = Array.from({ length: 10 }, (_, index) => ({
    impactId: `cm_impact_${(index + 1).toString(16).padStart(12, '0')}`,
    direction: directions[index % directions.length],
  }));
  const labels = (useful: number) => impacts.map((impact, index) => ({
    impactId: impact.impactId,
    useful: index < useful,
  }));
  Object.assign(
    asObject(asObject(candidate.historicalUsefulness, 'usefulness').result, 'result'),
    {
      status: 'complete',
      impactSetId: 'cm_impact_set_000000000001',
      impacts,
      customerJudgments: [
        {
          customerId: 'cm_customer_000000000001',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: syntheticDigest('customer-one'),
          independent: true,
          labels: labels(7),
        },
        {
          customerId: 'cm_customer_000000000002',
          externalTargetCustomer: true,
          qualificationEvidenceSha256: syntheticDigest('customer-two'),
          independent: false,
          labels: labels(8),
        },
      ],
      aggregateEvidenceSha256: syntheticDigest('customer-aggregate'),
    },
  );
}

function continuedProtocol(): JsonObject {
  const candidate = structuredClone(protocol);
  const base = asObject(candidate.baseRate, 'baseRate');
  const baseThresholds = asObject(base.thresholds, 'baseRate.thresholds');
  Object.assign(asObject(base.result, 'baseRate.result'), {
    status: 'complete',
    companyYears: 150,
    materialEventCount: 45,
    pointEstimate: 45 / 150,
    lowerBound: exactPoissonRateLowerBound(
      45,
      150,
      asNumber(baseThresholds.confidenceLevel, 'baseRate confidence'),
    ),
    privateSelectionManifestSha256: syntheticDigest('base-private'),
    aggregateEvidenceSha256: syntheticDigest('base-aggregate'),
  });
  const rediscovery = asObject(candidate.rediscovery, 'rediscovery');
  const rediscoveryThresholds = asObject(rediscovery.thresholds, 'rediscovery.thresholds');
  Object.assign(asObject(rediscovery.result, 'rediscovery.result'), {
    status: 'complete',
    pairCount: 100,
    rediscoveredCount: 70,
    pointEstimate: 0.7,
    lowerBound: exactBinomialLowerBound(
      70,
      100,
      asNumber(rediscoveryThresholds.confidenceLevel, 'rediscovery confidence'),
    ),
    privatePairManifestSha256: syntheticDigest('rediscovery-private'),
    aggregateEvidenceSha256: syntheticDigest('rediscovery-aggregate'),
  });
  completeUsefulness(candidate);
  candidate.firstScoredRunStartedAt = '2026-08-05T00:00:01.000Z';
  const provider = asObject(asObject(candidate.providerPolicy, 'provider').result, 'result');
  provider.status = 'approved';
  Object.assign(asObject(provider.exa, 'exa'), {
    status: 'approved',
    paidRuntimeApprovalEvidenceSha256: syntheticDigest('exa-runtime'),
  });
  Object.assign(asObject(provider.x, 'x'), {
    status: 'approved',
    writtenCommercialUseApprovalEvidenceSha256: syntheticDigest('x-runtime'),
    offlineContentComplianceEnforcedByRuntime: true,
    modelTrainingProhibitionEnforcedByRuntime: true,
  });
  Object.assign(asObject(provider.model, 'model'), {
    status: 'approved',
    zeroDataRetentionEnforcedByRuntime: true,
    noTrainingEnforcedByRuntime: true,
    reasoningDisabledEnforcedByRuntime: true,
    modelAndProviderPinnedByRuntime: true,
  });
  return candidate;
}

function curation(count = 2): CompanyMonitoringCurationManifest {
  return {
    schemaVersion: 'cm_public_evidence_curation_v1',
    collectionVersion: 'cm_collection_offline_v1',
    corpusVersion: 'cm_corpus_offline_v1',
    purpose: 'pilot',
    collectedAt: '2026-08-12T08:00:00.000Z',
    custody: {
      collectorTool: 'test-only',
      collectorModel: 'test-only',
      collectorRunId: 'test-only',
      storageClass: 'sealed_external',
      labelsVisibleToPolicyAuthors: false,
    },
    protocolVersion: 'cm_eval_v1',
    policyVersion: 'cm-admission-policy-v1',
    modelVersion: 'deepseek_v4_flash_digitalocean_v1',
    queryVersion: 'cm_provider_queries_v1',
    curatorAccessVersion: 'cm_curator_access_v1',
    candidates: Array.from({ length: count }, (_, index) => index + 1).map((ordinal) => ({
      candidateId: `candidate_${ordinal}`,
      disposition: 'included' as const,
      exclusionReason: null,
      opaqueExampleId: `cm_example_${ordinal.toString(16).padStart(6, '0')}`,
      company: {
        legalName: `Blind Boundary Company ${ordinal} Ltd`,
        stableIdentity: `company:${ordinal}`,
        corporateFamilyIdentity: `family:${ordinal}`,
        geography: 'US' as const,
        privateStatus: 'private' as const,
        privateStatusEvidence: {
          url: `https://registry.example/company/${ordinal}`,
          publisher: 'Registry',
          sourceOrigin: 'registry.example',
          retrievedAt: '2026-08-12T07:30:00.000Z',
        },
      },
      occurrence: {
        stableIdentity: `never-send-occurrence-${ordinal}`,
        occurredAt: `2026-08-${String(ordinal).padStart(2, '0')}T06:00:00.000Z`,
        occurredAtPrecision: 'second' as const,
        geography: 'US' as const,
      },
      primarySourceId: `reference_${ordinal}`,
      sources: [{
        sourceId: `reference_${ordinal}`,
        url: `https://reference.example/private-${ordinal}`,
        publisher: 'Reference Publisher',
        sourceOrigin: 'reference.example',
        title: `Never send reference title ${ordinal}`,
        boundedExcerpt: `Never send sealed curator excerpt ${ordinal}.`,
        publishedAt: `2026-08-${String(ordinal).padStart(2, '0')}T06:30:00.000Z`,
        publishedAtPrecision: 'second' as const,
        observedAt: '2026-08-12T07:00:00.000Z',
        retrievedAt: '2026-08-12T07:30:00.000Z',
        evidenceAuthority: 'independent_news' as const,
        syndication: {
          relationship: 'independent' as const,
          upstreamUrl: null,
          groupIdentity: `reference-family-${ordinal}`,
        },
      }],
    })),
  };
}

function lockedCorpus(input: CompanyMonitoringCurationManifest): BlindCorpus {
  const corpus = compileCompanyMonitoringBlindCorpus(input).corpus;
  return {
    ...corpus,
    status: 'locked',
    lockedAt: '2026-08-12T08:10:00.000Z',
    sealedGoldLabelsSha256: syntheticDigest('sealed-labels'),
  };
}

function observations(corpus: BlindCorpus): OfflineProviderObservationManifest {
  return {
    schemaVersion: 'cm_offline_provider_observations_v1',
    captureVersion: 'cm_capture_v1',
    corpusVersion: corpus.corpusVersion,
    corpusSha256: '',
    curationSha256: '',
    protocolVersion: corpus.protocolVersion,
    policyVersion: corpus.policyVersion,
    modelVersion: corpus.modelVersion,
    queryVersion: corpus.queryVersion,
    capturedAt: '2026-08-12T08:00:00.000Z',
    providerQueryVersions: {
      exa: 'exa-company-discovery-v1',
      x: 'x-company-discovery-v1',
    },
    runtime: {
      requestedModel: 'deepseek/deepseek-v4-flash',
      providerRoute: 'digitalocean',
      resolvedProvider: 'DigitalOcean',
    },
    custody: {
      storageClass: 'sealed_external',
      labelsVisibleToRuntime: false,
      referenceEvidenceVisibleToProviders: false,
    },
    rows: [{
      opaqueExampleId: 'cm_example_000001',
      coverage: { exa: 'complete', x: 'complete' },
      providerReceipts: {
        exa: syntheticDigest('exa-capture-receipt-1'),
        x: syntheticDigest('x-capture-receipt-1'),
      },
      latencyMs: 120,
      costUsd: 0.007,
      evidence: [{
        provider: 'exa',
        providerLocator: 'provider-result-1',
        providerReceiptSha256: syntheticDigest('provider-receipt'),
        queryVersion: 'exa-company-discovery-v1',
        url: 'https://provider-news.example/story-1',
        title: 'Blind Boundary Company 1 Ltd signs a major contract',
        text: 'Blind Boundary Company 1 Ltd signed a material multi-year contract.',
        author: 'Provider News',
        authorAccountId: null,
        officialCompanyDomain: null,
        publisherOrigin: 'provider-news.example',
        syndication: {
          relationship: 'independent',
          upstreamUrl: null,
          groupIdentity: 'provider-news-original-1',
        },
        publishedAt: Date.parse('2026-08-12T07:00:00.000Z'),
        observedAt: Date.parse('2026-08-12T08:00:00.000Z'),
        expiresAt: Date.parse('2026-08-15T08:00:00.000Z'),
        sourceAuthority: 'independent_source',
        verifiedCompany: false,
      }, {
        provider: 'x',
        providerLocator: '2000000000000000001',
        providerReceiptSha256: syntheticDigest('x-provider-receipt'),
        queryVersion: 'x-company-discovery-v1',
        url: 'https://x.com/i/status/2000000000000000001',
        title: null,
        text: 'Blind Boundary Company 1 Ltd signed a material multi-year contract.',
        author: 'blindboundaryco',
        authorAccountId: '1000000000000000001',
        officialCompanyDomain: null,
        publisherOrigin: '1000000000000000001',
        syndication: {
          relationship: 'independent',
          upstreamUrl: null,
          groupIdentity: 'blind-boundary-first-party-1',
        },
        publishedAt: Date.parse('2026-08-12T07:05:00.000Z'),
        observedAt: Date.parse('2026-08-12T08:00:00.000Z'),
        expiresAt: Date.parse('2026-08-15T08:00:00.000Z'),
        sourceAuthority: 'verified_first_party',
        verifiedCompany: true,
      }],
    }, {
      opaqueExampleId: 'cm_example_000002',
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: {
        exa: syntheticDigest('exa-capture-receipt-2'),
        x: null,
      },
      latencyMs: 100,
      costUsd: 0.007,
      evidence: [],
    }],
  };
}

async function bundle(count = 2) {
  const curator = curation(count);
  const corpus = lockedCorpus(curator);
  const captured = observations(corpus);
  captured.corpusSha256 = computeBlindCorpusDigest(corpus);
  captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(curator);
  return { curator, corpus, captured };
}

function modelOutput(evidenceIds: string[]): string {
  const axis = (truth: string, confidence: number) => ({
    truth,
    confidence,
    rationale: 'The provider evidence supports this conclusion.',
    evidenceIds,
  });
  return JSON.stringify({
    attribution: axis('confirmed', 0.99),
    occurrence: axis('confirmed', 0.95),
    materiality: axis('material', 0.9),
    direction: 'positive',
    channels: ['financial'],
    magnitude: 'high',
    category: 'contract',
    title: 'Company signs a major contract',
    neutralSummary: 'The company signed a material multi-year contract.',
    positiveRationale: 'The contract adds material revenue.',
    negativeRationale: '',
    conflict: false,
  });
}

function expectedError(code: string) {
  return (error: unknown) =>
    error instanceof CompanyMonitoringOfflinePredictionError && error.code === code;
}

describe('Company Monitoring sealed offline predictions', () => {
  it('stops before classifier access while the approved protocol remains STOP', async () => {
    const { curator, corpus, captured } = await bundle();
    let classifierCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol,
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        runtime: captured.runtime,
        checkpointAuthenticationKey,
        classify: async () => {
          classifierCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_runtime_protocol_stop'),
    );
    assert.equal(classifierCalls, 0);
  });

  it('uses only provider observations, applies the merged policy, and emits opaque predictions', async () => {
    const { curator, corpus, captured } = await bundle();
    let classifierInput = '';
    const times = [10, 35];
    const predictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      monotonicNow: () => times.shift()!,
      classify: async ({ candidate, evidence }) => {
        classifierInput = JSON.stringify({ candidate, evidence });
        return {
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: 'DigitalOcean',
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0.001,
        };
      },
    });

    assert.equal(predictions.predictions.length, 2);
    assert.deepEqual(predictions.predictions[0], {
      opaqueExampleId: 'cm_example_000001',
      discovered: true,
      publish: true,
      predictedMateriality: 'material',
      predictedDirection: 'positive',
      attributedCorporateFamilyDigest: corpus.examples[0]!.corporateFamilyDigest,
      confidence: 0.9,
      latencyMs: 145,
      costUsd: 0.008,
    });
    assert.equal(predictions.predictions[1]!.discovered, false);
    assert.equal(predictions.predictions[1]!.publish, false);
    assert.doesNotMatch(classifierInput, /reference\.example|Never send|sealed curator excerpt/);
    assert.doesNotMatch(JSON.stringify(predictions), /Blind Boundary Company|provider-news\.example/);
  });

  it('rejects incomplete coverage, observation reuse, and runtime drift', async () => {
    const { curator, corpus, captured } = await bundle();
    const base = {
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async () => ({
        content: '{}',
        route: {
          resolvedModel: captured.runtime.requestedModel,
          resolvedProvider: 'DigitalOcean',
          configuredProviderRoute: captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    };

    const incomplete = structuredClone(captured);
    incomplete.rows[0]!.coverage.exa = 'incomplete';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: incomplete }),
      expectedError('offline_provider_coverage_incomplete'),
    );

    const reused = structuredClone(captured);
    reused.rows[1]!.evidence = [structuredClone(reused.rows[0]!.evidence[0]!)];
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: reused }),
      expectedError('offline_observation_reused'),
    );

    const queryDrift = structuredClone(captured);
    queryDrift.rows[0]!.evidence[0]!.queryVersion = 'exa-company-discovery-v2';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: queryDrift }),
      expectedError('offline_observation_query_version_mismatch'),
    );

    const lateObservation = structuredClone(captured);
    lateObservation.rows[0]!.evidence[0]!.observedAt = Date.parse('2026-08-12T08:00:01.000Z');
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: lateObservation }),
      expectedError('offline_observation_after_capture'),
    );

    const changedAfterFreeze = structuredClone(captured);
    changedAfterFreeze.rows[0]!.latencyMs += 1;
    let digestMismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        observations: changedAfterFreeze,
        classify: async () => {
          digestMismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_observation_digest_mismatch'),
    );
    assert.equal(digestMismatchCalls, 0);

    const changedCuration = structuredClone(curator);
    changedCuration.candidates[0]!.company.legalName = 'Changed After Freeze Ltd';
    let curationMismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        curation: changedCuration,
        classify: async () => {
          curationMismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_curation_digest_mismatch'),
    );
    assert.equal(curationMismatchCalls, 0);

    const missingEmptyReceipt = structuredClone(captured);
    missingEmptyReceipt.rows[1]!.providerReceipts.exa = null;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: missingEmptyReceipt }),
      expectedError('offline_provider_receipt_invalid'),
    );

    const falseOfficial = structuredClone(captured);
    falseOfficial.rows[0]!.evidence[0]!.sourceAuthority = 'verified_first_party';
    falseOfficial.rows[0]!.evidence[0]!.verifiedCompany = true;
    falseOfficial.rows[0]!.evidence[0]!.officialCompanyDomain = 'company.example';
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({ ...base, observations: falseOfficial }),
      expectedError('offline_observation_verification_invalid'),
    );

    for (const custody of [
      { ...captured.custody, storageClass: 'repository' },
      { ...captured.custody, labelsVisibleToRuntime: true },
      { ...captured.custody, referenceEvidenceVisibleToProviders: true },
    ]) {
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          ...base,
          observations: { ...captured, custody } as unknown as OfflineProviderObservationManifest,
        }),
        expectedError('offline_custody_boundary_invalid'),
      );
    }

    let mismatchCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...base,
        observations: captured,
        runtime: { ...captured.runtime, providerRoute: 'other-provider' },
        checkpointAuthenticationKey,
        classify: async () => {
          mismatchCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_classifier_configuration_mismatch'),
    );
    assert.equal(mismatchCalls, 0);

    const validResult = {
      content: modelOutput([]),
      route: {
        resolvedModel: captured.runtime.requestedModel,
        resolvedProvider: captured.runtime.resolvedProvider,
        configuredProviderRoute: captured.runtime.providerRoute,
      },
      costUsd: 0,
    };
    const invalidResults = [
      { ...validResult, route: { ...validResult.route, resolvedModel: 'other/model' } },
      { ...validResult, route: { ...validResult.route, resolvedProvider: 'Other Provider' } },
      { ...validResult, route: { ...validResult.route, configuredProviderRoute: 'other-route' } },
      { ...validResult, costUsd: -1 },
      { ...validResult, costUsd: Number.NaN },
    ];
    for (const result of invalidResults) {
      await assert.rejects(
        runCompanyMonitoringOfflinePredictions({
          ...base,
          observations: captured,
          classify: async ({ evidence }) => ({
            ...result,
            content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          }),
        }),
        expectedError('offline_classifier_runtime_mismatch'),
      );
    }
  });

  it('binds a validated sealed observation manifest to a deterministic digest', async () => {
    const { corpus, captured } = await bundle();
    const first = computeOfflineProviderObservationDigest(captured, corpus);
    const second = computeOfflineProviderObservationDigest(structuredClone(captured), corpus);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
  });

  it('binds the prediction output to a versioned sealed run receipt', async () => {
    const { curator, corpus, captured } = await bundle();
    const predictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => ({
        content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
        route: {
          resolvedModel: captured.runtime.requestedModel,
          resolvedProvider: captured.runtime.resolvedProvider,
          configuredProviderRoute: captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    });
    const receipt = createOfflinePredictionRunReceipt({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      corpus,
      observations: captured,
      predictions,
    });

    assert.equal(receipt.curationSha256, computeCompanyMonitoringCurationManifestDigest(curator));
    assert.equal(receipt.approvedThresholdDigest, approvedThresholdDigest);
    assert.match(receipt.protocolSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.providerObservationsSha256, computeOfflineProviderObservationDigest(captured, corpus));
    assert.equal(receipt.predictionSetSha256, computePredictionSetDigest(predictions));
    assert.deepEqual(receipt.runtime, captured.runtime);

    const predictionBundle = createOfflinePredictionBundle({
      predictions,
      receipt,
      signingPrivateKeyPem: bundleSigningPrivateKeyPem,
    });
    assert.deepEqual(validateOfflinePredictionBundle({
      bundle: predictionBundle,
      verificationPublicKeyPem: bundleVerificationPublicKeyPem,
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
    }), predictions);
    const forged = structuredClone(predictionBundle);
    forged.receipt.runtime.resolvedProvider = 'Forged Provider';
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: forged,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
    const incompatiblePredictions = structuredClone(predictions);
    incompatiblePredictions.policyVersion = 'cm-admission-policy-v2';
    const incompatibleBundle = createOfflinePredictionBundle({
      predictions: incompatiblePredictions,
      receipt: createOfflinePredictionRunReceipt({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        corpus,
        observations: captured,
        predictions: incompatiblePredictions,
      }),
      signingPrivateKeyPem: bundleSigningPrivateKeyPem,
    });
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: incompatibleBundle,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
    const edited = structuredClone(predictionBundle);
    edited.predictions.predictions[0]!.confidence = 0.01;
    edited.receipt = createOfflinePredictionRunReceipt({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      corpus,
      observations: captured,
      predictions: edited.predictions,
    });
    assert.throws(
      () => validateOfflinePredictionBundle({
        bundle: edited,
        verificationPublicKeyPem: bundleVerificationPublicKeyPem,
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: curator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
        corpus,
        observations: captured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      }),
      expectedError('offline_prediction_bundle_invalid'),
    );
  });

  it('preserves verified first-party Exa authority only for a bound official domain', async () => {
    const { curator, corpus, captured } = await bundle();
    const exa = captured.rows[0]!.evidence[0]!;
    exa.url = 'https://news.blindboundary.example/material-event';
    exa.publisherOrigin = 'news.blindboundary.example';
    exa.sourceAuthority = 'verified_first_party';
    exa.verifiedCompany = true;
    exa.officialCompanyDomain = 'blindboundary.example';
    let exaAuthority: string | undefined;

    await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => {
        exaAuthority = evidence.find((row) => row.provider === 'exa')?.sourceAuthority;
        return {
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(exaAuthority, 'verified_first_party');
  });

  it('preserves parent predictions and classifies only a continuation expansion', async () => {
    const parent = await bundle();
    parent.curator.purpose = 'stage3_gate';
    parent.corpus.purpose = 'stage3_gate';
    const childCurator = curation(3);
    childCurator.corpusVersion = 'cm_corpus_offline_v2';
    childCurator.purpose = 'stage3_gate';
    const childCorpus = lockedCorpus(childCurator);
    const expansion = childCorpus.examples.slice(parent.corpus.examples.length);
    parent.corpus.precommittedExpansion = {
      manifestSha256: computeExpansionManifestDigest(expansion),
      exampleCount: expansion.length,
    };
    parent.captured.corpusSha256 = computeBlindCorpusDigest(parent.corpus);
    parent.captured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(parent.curator);
    const parentPredictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: parent.curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(parent.curator),
      corpus: parent.corpus,
      observations: parent.captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(parent.captured, parent.corpus),
      runtime: parent.captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => ({
        content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
        route: {
          resolvedModel: parent.captured.runtime.requestedModel,
          resolvedProvider: parent.captured.runtime.resolvedProvider,
          configuredProviderRoute: parent.captured.runtime.providerRoute,
        },
        costUsd: 0,
      }),
    });
    const parentCorpusSha256 = computeBlindCorpusDigest(parent.corpus);
    const parentPredictionSetSha256 = computePredictionSetDigest(parentPredictions);
    const parentReport = {
      schemaVersion: 'cm_blind_score_report_v1',
      reportSha256: '',
      outcome: 'incomplete',
      reasons: ['publication_precision_denominator_insufficient'],
      protocol: { version: parent.corpus.protocolVersion, approvedThresholdsSha256: approvedThresholdDigest },
      corpus: {
        version: parent.corpus.corpusVersion,
        sha256: parentCorpusSha256,
        purpose: 'stage3_gate',
        exampleCount: parent.corpus.examples.length,
        parentCorpusVersion: null,
      },
      versions: {
        policyVersion: parent.corpus.policyVersion,
        modelVersion: parent.corpus.modelVersion,
        queryVersion: parent.corpus.queryVersion,
        goldLabelVersion: 'cm_gold_v1',
        curatorAccessVersion: parent.corpus.curatorAccessVersion,
      },
      forecast: {}, observedDenominators: {}, metrics: {}, discovery: {}, customerUsefulness: {},
      confusionMatrices: {}, calibration: {}, latency: {}, cost: {},
      predictionSetSha256: parentPredictionSetSha256,
      goldLabelSetSha256: parent.corpus.sealedGoldLabelsSha256,
    } as unknown as ScoreReport;
    parentReport.reportSha256 = computeScoreReportDigest(parentReport);
    childCorpus.continuation = {
      parentCorpusVersion: parent.corpus.corpusVersion,
      parentCorpusSha256,
      parentReportSha256: parentReport.reportSha256,
      reason: 'denominator_shortfall',
    };
    const childCaptured = observations(childCorpus);
    childCaptured.rows.push({
      opaqueExampleId: 'cm_example_000003',
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: { exa: syntheticDigest('exa-capture-receipt-3'), x: null },
      latencyMs: 80,
      costUsd: 0.002,
      evidence: [{
        ...structuredClone(childCaptured.rows[0]!.evidence[0]!),
        providerLocator: 'provider-result-3',
        providerReceiptSha256: syntheticDigest('provider-receipt-3'),
        url: 'https://provider-news.example/story-3',
        title: 'Blind Boundary Company 3 Ltd signs a major contract',
        text: 'Blind Boundary Company 3 Ltd signed a material contract.',
      }],
    });
    childCaptured.corpusSha256 = computeBlindCorpusDigest(childCorpus);
    childCaptured.curationSha256 = computeCompanyMonitoringCurationManifestDigest(childCurator);
    const continuationKeyPair = generateKeyPairSync('ed25519');
    const authorizationBody = {
      schemaVersion: 'cm_offline_continuation_authorization_v1' as const,
      outcome: 'incomplete' as const,
      approvedThresholdDigest,
      parentCorpusSha256,
      parentPredictionSetSha256,
      parentGoldLabelSetSha256: parent.corpus.sealedGoldLabelsSha256!,
      parentReportSha256: parentReport.reportSha256,
      childCorpusSha256: computeBlindCorpusDigest(childCorpus),
      expansionManifestSha256: parent.corpus.precommittedExpansion!.manifestSha256,
    };
    const authorization: OfflineContinuationAuthorization = {
      ...authorizationBody,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalJson(authorizationBody)),
        continuationKeyPair.privateKey,
      ).toString('base64'),
    };
    const continuationPrevious = {
      corpus: parent.corpus,
      expectedCorpusSha256: parentCorpusSha256,
      predictions: parentPredictions,
      expectedPredictionSetSha256: parentPredictionSetSha256,
      report: parentReport,
      expectedReportSha256: parentReport.reportSha256,
      authorization,
      authorizationPublicKeyPem: continuationKeyPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }).toString(),
    };
    let unauthorizedCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        protocol: continuedProtocol(),
        approvedThresholdDigest,
        curation: childCurator,
        expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(childCurator),
        corpus: childCorpus,
        observations: childCaptured,
        expectedObservationsSha256: computeOfflineProviderObservationDigest(childCaptured, childCorpus),
        runtime: childCaptured.runtime,
        checkpointAuthenticationKey,
        previous: {
          ...continuationPrevious,
          authorization: { ...authorization, signatureBase64: Buffer.alloc(64).toString('base64') },
        },
        classify: async () => {
          unauthorizedCalls += 1;
          throw new Error('must not run');
        },
      }),
      expectedError('offline_continuation_authorization_invalid'),
    );
    assert.equal(unauthorizedCalls, 0);
    let classifierCalls = 0;
    const childPredictions = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: childCurator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(childCurator),
      corpus: childCorpus,
      observations: childCaptured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(childCaptured, childCorpus),
      runtime: childCaptured.runtime,
      checkpointAuthenticationKey,
      previous: continuationPrevious,
      classify: async ({ evidence }) => {
        classifierCalls += 1;
        return {
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: childCaptured.runtime.requestedModel,
            resolvedProvider: childCaptured.runtime.resolvedProvider,
            configuredProviderRoute: childCaptured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(classifierCalls, 1);
    assert.deepEqual(childPredictions.predictions.slice(0, 2), parentPredictions.predictions);
    assert.equal(childPredictions.parentPredictionSetSha256, parentPredictionSetSha256);
    assert.equal(childPredictions.parentGoldLabelSetSha256, parent.corpus.sealedGoldLabelsSha256);
  });

  it('bounds concurrent classifications and retains opaque corpus order', async () => {
    const { curator, corpus, captured } = await bundle(6);
    const template = captured.rows[0]!.evidence[0]!;
    captured.rows = corpus.examples.map((example, index) => ({
      opaqueExampleId: example.opaqueExampleId,
      coverage: { exa: 'complete', x: 'not_applicable' },
      providerReceipts: {
        exa: syntheticDigest(`exa-capture-receipt-${index + 1}`),
        x: null,
      },
      latencyMs: 0,
      costUsd: 0,
      evidence: [{
        ...template,
        providerLocator: `provider-result-${index + 1}`,
        url: `https://provider-news.example/story-${index + 1}`,
        title: `Blind Boundary Company ${index + 1} Ltd signs a major contract`,
        text: `Blind Boundary Company ${index + 1} Ltd signed a material contract.`,
      }],
    }));

    let active = 0;
    let maximumActive = 0;
    const result = await runCompanyMonitoringOfflinePredictions({
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
      classify: async ({ evidence }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    });

    assert.equal(maximumActive, 4);
    assert.deepEqual(
      result.predictions.map((prediction) => prediction.opaqueExampleId),
      [...corpus.examples.map((example) => example.opaqueExampleId)].sort(),
    );
  });

  it('resumes from anchored checkpoints after a late concurrent failure', async () => {
    const { curator, corpus, captured } = await bundle(6);
    const template = captured.rows[0]!.evidence[0]!;
    captured.rows = corpus.examples.map((example, index) => ({
      opaqueExampleId: example.opaqueExampleId,
      coverage: { exa: 'complete' as const, x: 'not_applicable' as const },
      providerReceipts: {
        exa: syntheticDigest(`resume-capture-receipt-${index + 1}`),
        x: null,
      },
      latencyMs: 0,
      costUsd: 0,
      evidence: [{
        ...template,
        providerLocator: `resume-provider-result-${index + 1}`,
        url: `https://provider-news.example/resume-${index + 1}`,
        title: `Blind Boundary Company ${index + 1} Ltd signs a major contract`,
        text: `Blind Boundary Company ${index + 1} Ltd signed a material contract.`,
      }],
    }));
    const anchors = {
      protocol: continuedProtocol(),
      approvedThresholdDigest,
      curation: curator,
      expectedCurationSha256: computeCompanyMonitoringCurationManifestDigest(curator),
      corpus,
      observations: captured,
      expectedObservationsSha256: computeOfflineProviderObservationDigest(captured, corpus),
      runtime: captured.runtime,
      checkpointAuthenticationKey,
    };
    const checkpoints: OfflinePredictionCheckpoint[] = [];
    await assert.rejects(runCompanyMonitoringOfflinePredictions({
      ...anchors,
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
      classify: async ({ candidate, evidence }) => {
        if (candidate.companyId.endsWith('000003')) throw new Error('injected late failure');
        return {
          content: modelOutput(evidence.map((row) => row.evidenceFingerprint)),
          route: {
            resolvedModel: captured.runtime.requestedModel,
            resolvedProvider: captured.runtime.resolvedProvider,
            configuredProviderRoute: captured.runtime.providerRoute,
          },
          costUsd: 0,
        };
      },
    }), /injected late failure/);
    assert.ok(checkpoints.length > 0);

    const completed = checkpoints.filter((checkpoint) => checkpoint.state === 'completed');
    assert.ok(completed.length > 0);
    const tampered = structuredClone(completed);
    tampered[0]!.prediction!.confidence = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints: tampered,
        checkpointAuthenticationKey,
        classify: async () => { throw new Error('must not run'); },
      }),
      expectedError('offline_checkpoint_authentication_invalid'),
    );
    let resumedCalls = 0;
    await assert.rejects(
      runCompanyMonitoringOfflinePredictions({
        ...anchors,
        checkpoints,
        classify: async () => {
          resumedCalls += 1;
          throw new Error('must not run before reconciliation');
        },
      }),
      expectedError('offline_checkpoint_reconciliation_required'),
    );
    assert.equal(resumedCalls, 0);
  });

  it('exits the run command before credentials or sealed inputs while the protocol remains STOP', () => {
    const result = spawnSync(
      fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
      [
        fileURLToPath(new URL('../scripts/company-monitoring-offline-predictions.mts', import.meta.url)),
        'run',
        '--protocol',
        fileURLToPath(new URL('./fixtures/company-monitoring-evaluation/protocol.json', import.meta.url)),
        '--approved-threshold-digest',
        approvedThresholdDigest,
        '--curation',
        '/sealed/not-readable-curation.json',
        '--corpus',
        '/sealed/not-readable-corpus.json',
        '--observations',
        '/sealed/not-readable-observations.json',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          COMPANY_MONITORING_CLASSIFIER_MODEL: '',
          COMPANY_MONITORING_CLASSIFIER_PROVIDER_ROUTE: '',
          OPENROUTER_API_KEY: '',
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'offline_runtime_protocol_stop\n');
  });
});
