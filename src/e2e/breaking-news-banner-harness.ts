import '../styles/main.css';
import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import { initI18n } from '@/services/i18n';
import type { BreakingAlert } from '@/services/breaking-news-alerts';

declare global {
  interface Window {
    __breakingNewsBannerHarness?: {
      ready: boolean;
      layout: 'overlay' | 'in-flow';
    };
  }
}

const SAMPLE_ALERTS: BreakingAlert[] = [
  {
    id: 'harness-reuters',
    headline: 'Wire service reports a verified development',
    source: 'Reuters',
    threatLevel: 'critical',
    timestamp: new Date(),
    origin: 'rss_alert',
    link: 'https://example.com/reuters',
  },
  {
    id: 'harness-aljazeera',
    headline: 'Regional outlet files a caution-tagged dispatch',
    source: 'Al Jazeera',
    threatLevel: 'high',
    timestamp: new Date(),
    origin: 'rss_alert',
    link: 'https://example.com/aljazeera',
  },
  {
    id: 'harness-miit',
    headline: 'Official ministry publishes an industrial policy update',
    source: 'MIIT (China)',
    threatLevel: 'high',
    timestamp: new Date(),
    origin: 'rss_alert',
    link: 'https://example.com/miit',
  },
];

window.__breakingNewsBannerHarness = { ready: false, layout: 'overlay' };

await initI18n();

new BreakingNewsBanner();

const container = document.querySelector('.breaking-news-container');
const header = document.querySelector('.header');
const inFlow = Boolean(header && header.nextElementSibling === container);
window.__breakingNewsBannerHarness.layout = inFlow ? 'in-flow' : 'overlay';

for (const alert of SAMPLE_ALERTS) {
  document.dispatchEvent(new CustomEvent<BreakingAlert>('wm:breaking-news', { detail: alert }));
}

window.__breakingNewsBannerHarness.ready = true;
