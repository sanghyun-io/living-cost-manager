#!/usr/bin/env node
// Fixed choices only: never accept names, emails, free-text terms, or arbitrary URLs.
import { pathToFileURL } from 'node:url';

export const campaigns = Object.freeze(['renewal-checklist', 'billing-calendar', 'local-first']);
export const sources = Object.freeze(['community', 'newsletter', 'social', 'interview']);
export const destinations = Object.freeze({
  guide: '/guide/',
  billing: '/guide/billing-dates/',
  renewal: '/guide/renewal-checklist/',
  backup: '/guide/backup-and-sync/',
  faq: '/guide/faq/',
});

export function campaignUrl(campaign, source, destination = 'guide') {
  if (!campaigns.includes(campaign) || !sources.includes(source)
    || !Object.hasOwn(destinations, destination)) {
    throw new Error('Use only the documented campaign, source and destination choices.');
  }
  const url = new URL(destinations[destination], 'https://living-cost-manager.gamja.top');
  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', source === 'newsletter' ? 'email' : source === 'social' ? 'social' : 'referral');
  url.searchParams.set('utm_campaign', campaign);
  return url.href;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3) throw new Error('Expected 2 or 3 arguments.');
    console.log(campaignUrl(...args));
  } catch {
    console.error(`Usage: node scripts/marketing/campaign-url.mjs <${campaigns.join('|')}> <${sources.join('|')}> [${Object.keys(destinations).join('|')}]`);
    process.exitCode = 1;
  }
}
