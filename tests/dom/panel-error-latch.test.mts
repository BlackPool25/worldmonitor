/**
 * #6577 — panels that repaint `this.content` themselves must clear the WHOLE
 * error state on their success render, not just the header chip.
 *
 * `showError(msg, onRetry)` does three things: it sets the header "Error" chip,
 * it arms a `setInterval` countdown that fires `onRetry` when it reaches zero,
 * and it advances `retryAttempt` so the next failure waits twice as long
 * (15s -> 30s -> 60s ... capped at 180s).
 *
 * `setContentHtml` unwinds all three implicitly. Panels that paint with
 * `replaceChildren(this.content, ...)` bypass that path, so they must call the
 * public `clearErrorState()` themselves. The panels below used to call
 * `setErrorState(false)`, which drops ONLY the chip — leaving the countdown
 * ticking against a panel that had already recovered (one redundant refresh per
 * recovery) and leaving the backoff latched a step high, so the next real
 * failure re-entered at the wrong rung.
 *
 * Each case drives the panel's OWN error and success call sites rather than the
 * shared `Panel` helper: a single mutation of `clearErrorState()` would be
 * killed by any one of them, but a per-site regression (one panel left on
 * `setErrorState`) is only visible if every site is exercised separately.
 * See docs/solutions/conventions/mutate-each-call-site-a-global-mutant-hides-per-site-holes.md
 *
 * The LOADING branches are deliberately not covered here: they must keep using
 * the raw write / `showLoading()`, which clears the chip and countdown but
 * leaves `retryAttempt` alone. Resetting the backoff on a loading render would
 * re-arm every retry at 15s forever and defeat the exponential backoff.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  mockFetchTopicIntelligence,
  mockFetchTopicTimeline,
  mockRenderGivingPanelContent,
  mockAvailableGivingTabs,
} = vi.hoisted(() => ({
  mockFetchTopicIntelligence: vi.fn(),
  mockFetchTopicTimeline: vi.fn(),
  mockRenderGivingPanelContent: vi.fn(),
  mockAvailableGivingTabs: vi.fn(),
}));

vi.mock('@/services/gdelt-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/gdelt-intel')>(),
  fetchTopicIntelligence: mockFetchTopicIntelligence,
  fetchTopicTimeline: mockFetchTopicTimeline,
}));

vi.mock('@/components/giving-renderer', () => ({
  availableGivingTabs: mockAvailableGivingTabs,
  renderGivingPanelContent: mockRenderGivingPanelContent,
}));

import { DefensePatentsPanel } from '@/components/DefensePatentsPanel';
import { GdeltIntelPanel } from '@/components/GdeltIntelPanel';
import { GivingPanel } from '@/components/GivingPanel';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { TechEventsPanel } from '@/components/TechEventsPanel';

/** Base-class state these tests reach into to observe the latch. */
interface PanelInternals {
  element: HTMLElement;
  header: HTMLElement;
  content: HTMLElement;
  retryCallback: (() => void) | null;
}

/** Per-panel fields the render() call sites branch on. */
interface RenderFlags {
  loading: boolean;
  error: string | null;
}

function internals(panel: object): PanelInternals {
  return panel as unknown as PanelInternals;
}

function flags(panel: object): RenderFlags {
  return panel as unknown as RenderFlags;
}

function mount(panel: object): void {
  document.body.appendChild(internals(panel).element);
}

/** The countdown line rendered by `showError`, e.g. "Retrying (15s)". */
function countdownText(panel: object): string | null {
  return internals(panel).content.querySelector('.panel-error-countdown')?.textContent ?? null;
}

/** The header "Error" chip is a class on the header, not a child element. */
function hasErrorChip(panel: object): boolean {
  return internals(panel).header.classList.contains('panel-header-error');
}

/**
 * Drive one panel's real error site, then its real success site, and assert the
 * recovery unwound the countdown AND the backoff — not just the chip.
 */
async function expectRecoveryClearsRetryState(
  panel: object,
  driveError: () => void | Promise<void>,
  driveSuccess: () => void | Promise<void>,
): Promise<void> {
  await driveError();

  // Preconditions: the error site really did set the chip and arm a real
  // countdown on a fresh panel, so neither assertion below can pass vacuously
  // against a panel that was never in an error state to begin with.
  expect(hasErrorChip(panel)).toBe(true);
  expect(countdownText(panel)).toMatch(/\(15s\)/);

  // Swap the panel's own retry for a spy: an interval that survives the success
  // render is otherwise invisible, since the success write already replaced the
  // countdown element in the DOM.
  const orphanedRetry = vi.fn();
  internals(panel).retryCallback = orphanedRetry;

  await driveSuccess();

  expect(hasErrorChip(panel)).toBe(false);

  // 1. The pending auto-retry must not outlive the recovery.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(orphanedRetry).not.toHaveBeenCalled();

  // 2. The backoff must be back at rung 0 — the next failure waits 15s, not 30s.
  (panel as { showError(m?: string, r?: () => void): void }).showError('again', () => {});
  expect(countdownText(panel)).toMatch(/\(15s\)/);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ServiceStatusPanel', () => {
  it('clears the countdown and backoff when the service list renders', async () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('TechEventsPanel', () => {
  it('clears the countdown and backoff when the events list renders', async () => {
    const fetchEvents = vi
      .spyOn(TechEventsPanel.prototype as unknown as { fetchEvents(): Promise<void> }, 'fetchEvents')
      .mockResolvedValue(undefined);

    const panel = new TechEventsPanel('tech-events');
    mount(panel);
    expect(fetchEvents).toHaveBeenCalled();

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('DefensePatentsPanel', () => {
  it('clears the countdown and backoff when the patents list renders', async () => {
    const fetchPatents = vi
      .spyOn(DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> }, 'fetchPatents')
      .mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);
    expect(fetchPatents).toHaveBeenCalled();

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        flags(panel).loading = false;
        flags(panel).error = 'boom';
        (panel as unknown as { render(): void }).render();
      },
      () => {
        flags(panel).error = null;
        (panel as unknown as { render(): void }).render();
      },
    );

    panel.destroy();
  });
});

describe('GdeltIntelPanel', () => {
  /**
   * `renderArticles` is the success site for BOTH callers, and only one of them
   * can prove the countdown clears: `loadActiveTopic` opens with `showLoading()`
   * (which drops the countdown but deliberately keeps the backoff), whereas the
   * cached `selectTopic` branch paints straight over a live error state. The
   * case below drives `renderArticles` directly so the pending countdown is
   * still armed when the success write lands — the cached-topic scenario.
   */
  it('clears the countdown and backoff when articles render', async () => {
    mockFetchTopicIntelligence.mockResolvedValue({ articles: [], fetchedAt: new Date() });
    mockFetchTopicTimeline.mockResolvedValue(null);

    const panel = new GdeltIntelPanel();
    mount(panel);
    await vi.advanceTimersByTimeAsync(0);

    await expectRecoveryClearsRetryState(
      panel,
      async () => {
        mockFetchTopicIntelligence.mockRejectedValue(new Error('boom'));
        mockFetchTopicTimeline.mockRejectedValue(new Error('boom'));
        await (panel as unknown as { loadActiveTopic(): Promise<void> }).loadActiveTopic();
      },
      () => {
        (panel as unknown as { renderArticles(a: unknown[]): void }).renderArticles([]);
      },
    );

    panel.destroy();
  });
});

describe('GivingPanel', () => {
  /**
   * Latent, not live: `data-loader.showColdLoadError` reaches this panel as a
   * bare `callPanel('giving', 'showError')` with no retry callback, and the
   * panel never calls `setRetryCallback` — so today `showError` skips the
   * countdown block entirely and nothing latches. This case drives the public
   * `showError(msg, onRetry)` overload to pin the contract for the day a retry
   * callback IS wired in, which is the only reason `setData` needs the full
   * `clearErrorState()` rather than a chip reset.
   */
  it('clears the countdown and backoff when a summary renders', async () => {
    mockAvailableGivingTabs.mockReturnValue(['platforms']);
    mockRenderGivingPanelContent.mockReturnValue('<div class="giving-body"></div>');

    const panel = new GivingPanel();
    mount(panel);

    await expectRecoveryClearsRetryState(
      panel,
      () => {
        panel.showError('boom', () => {});
      },
      () => {
        panel.setData({
          materializedAt: new Date(Date.now() - 60_000).toISOString(),
          platforms: [{ platform: 'Platform 1' }],
        } as unknown as Parameters<GivingPanel['setData']>[0]);
      },
    );

    panel.destroy();
  });
});
