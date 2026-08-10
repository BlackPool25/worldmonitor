/**
 * Publisher-family resolution for corroboration counting (#6428).
 *
 * A cluster's `sources` array holds FEED LABELS, and a feed label is not a
 * publisher: `BBC World`, `BBC Africa` and `BBC Persian` are three labels for
 * one newsroom, and `Reuters World` + `Reuters US` + `Reuters Business` are
 * three labels for one wire. Counting labels let a single story reprinted
 * across one publisher's own editions clear a "two independent sources" gate.
 * Every corroboration gate must count families instead.
 *
 * FAIL CLOSED, in the direction that never invents independence:
 *   - an unmapped label is its OWN family. A new feed is never silently
 *     folded into an existing publisher, and it never disappears from the
 *     count either — it just cannot claim to corroborate anything but itself.
 *   - singleton family ids are namespaced (`label:<name>`) so they can never
 *     collide with a curated family id.
 *
 * KNOWN LIMIT — cross-publisher syndication. This map collapses one
 * publisher's own labels. It cannot see that an unrelated outlet reprinted a
 * Reuters wire, because the feed label the item arrives under says nothing
 * about the wire it came from: the ingest parser stamps `item.source =
 * feed.name` (server/worldmonitor/news/v1/list-feed-digest.ts) and drops the
 * RSS `<source>` element that names the originating publisher. Recovering
 * that is tracked in #6430; it is a parser change, not a map change.
 */
import PUBLISHER_FAMILY_DATA from './publisher-families.json' with { type: 'json' };

export const PUBLISHER_FAMILIES = Object.freeze(PUBLISHER_FAMILY_DATA.families);

/** Namespace for a label that no curated family claims. */
const SINGLETON_PREFIX = 'label:';

const familyByLabel = new Map();
const familyByLowerLabel = new Map();
for (const [familyId, entry] of Object.entries(PUBLISHER_FAMILY_DATA.families)) {
  for (const label of entry.labels) {
    familyByLabel.set(label, familyId);
    familyByLowerLabel.set(label.toLowerCase(), familyId);
  }
}

/**
 * Family id for one feed label. Returns '' for a blank/non-string label so
 * callers can drop it rather than counting an empty source.
 *
 * The lowercase fallback still resolves to a CURATED label — it absorbs
 * casing drift between the client and server feed configs without ever
 * fuzzy-matching an unknown label into a family.
 *
 * @param {unknown} label
 * @returns {string}
 */
export function publisherFamilyFor(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (trimmed.length === 0) return '';
  return familyByLabel.get(trimmed)
    ?? familyByLowerLabel.get(trimmed.toLowerCase())
    ?? `${SINGLETON_PREFIX}${trimmed}`;
}

/**
 * Distinct publisher families across a list of feed labels.
 *
 * @param {unknown} labels
 * @returns {Set<string>}
 */
export function publisherFamiliesFor(labels) {
  const families = new Set();
  if (!Array.isArray(labels)) return families;
  for (const label of labels) {
    const family = publisherFamilyFor(label);
    if (family) families.add(family);
  }
  return families;
}

/**
 * How many distinct publishers a list of feed labels actually represents.
 * This is the number every corroboration gate is allowed to reason about.
 *
 * @param {unknown} labels
 * @returns {number}
 */
export function countPublisherFamilies(labels) {
  return publisherFamiliesFor(labels).size;
}

/**
 * Human-readable publisher name for a family id, for user-facing copy.
 * A singleton family renders as the feed label it was derived from.
 *
 * @param {unknown} familyId
 * @returns {string}
 */
export function publisherNameForFamily(familyId) {
  if (typeof familyId !== 'string' || familyId.length === 0) return '';
  if (familyId.startsWith(SINGLETON_PREFIX)) return familyId.slice(SINGLETON_PREFIX.length);
  return PUBLISHER_FAMILY_DATA.families[familyId]?.publisher ?? familyId;
}
