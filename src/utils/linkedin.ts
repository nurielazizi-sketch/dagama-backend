export function buildLinkedInSearchURL(fullName: string, company: string): string {
  const query = encodeURIComponent(`${fullName} ${company}`.trim());
  return `https://www.linkedin.com/search/results/people/?keywords=${query}`;
}

export function isLinkedInProfileURL(text: string): boolean {
  return /linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/.test(text);
}

export function cleanLinkedInURL(url: string): string {
  // Strip tracking params, keep only the profile path
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return `https://www.linkedin.com${parsed.pathname}`;
  } catch {
    return url.split('?')[0].trim();
  }
}
