import type { Api } from '@jellyfin/sdk';
import { catalogueYearTypeMatches, discoveryCandidates, exactCatalogMatches, field, searchFailureDetails, seerrLink, verifiedCatalogItem,
    type Discovery, type DiscoveryIssue, type Finding, type SearchAnswer } from './aiSearch';

// Plugin version, not a network address. Reinspect source/hooks after an upgrade.
// eslint-disable-next-line sonarjs/no-hardcoded-ip
const ENHANCED_VERSION = '12.11.0.0';

interface Enhanced {
    pluginVersion?: string;
    jellyseerrAPI?: { resolveJellyseerrBaseUrl: () => string };
    hiddenContent?: { filterJellyseerrResults: (items: unknown[], context: string) => unknown[] };
}
function enhanced(): Enhanced | undefined {
    return (window as Window & { JellyfinEnhanced?: Enhanced }).JellyfinEnhanced;
}
export function compatibleSearchHooks(): boolean {
    const version = enhanced()?.pluginVersion;
    const kefinScripts = [...document.scripts].map(script => script.src)
        .filter(src => src.includes('KefinTweaks@') && src.includes('/scripts/search.js'));
    return typeof AbortController !== 'undefined' && typeof URL !== 'undefined'
        && (!version || version === ENHANCED_VERSION)
        && kefinScripts.every(src => src.includes('KefinTweaks@v0.4.13/'));
}
export async function pluginRequest(api: Api, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    // SDK auth, same Jellyfin server/base path. No Enhanced retry/cache wrapper.
    const response = await api.axiosInstance.request({
        url: api.getUri(path), method: body === undefined ? 'GET' : 'POST', data: body,
        // Cover the server's supported 180-second research timeout plus time for
        // local matching. The configured server deadline still ends research first.
        headers: { Authorization: api.authorizationHeader }, signal, timeout: body === undefined ? 15000 : 210000
    });
    return response.data;
}
export async function lookupDiscovery(api: Api, answer: SearchAnswer, signal: AbortSignal): Promise<{
    cards: Discovery[]; unresolved: number; issues?: DiscoveryIssue[];
}> {
    const candidates = discoveryCandidates(answer);
    if (!candidates.length) return { cards: [], unresolved: 0 };
    const pages = answer.cataloguePageLimit ?? 5;
    if (!Number.isInteger(pages) || pages < 1 || pages > 10) throw new Error('Invalid catalogue page limit.');
    const issue = (finding: Finding, reason: string): DiscoveryIssue => ({ kind: finding.kind, title: finding.title, year: finding.year, reason });
    const je = enhanced();
    const base = je?.jellyseerrAPI?.resolveJellyseerrBaseUrl();
    if (je?.pluginVersion !== ENHANCED_VERSION || !base || !seerrLink(base, 'Movie', 1)) {
        return { cards: [], unresolved: candidates.length,
            issues: candidates.map(f => issue(f, 'Seerr discovery is unavailable with the current integration.')) };
    }
    const status = await pluginRequest(api, '/JellyfinEnhanced/jellyseerr/user-status', signal);
    if (field(status, 'active') !== true || field(status, 'userFound') !== true) {
        return { cards: [], unresolved: candidates.length,
            issues: candidates.map(f => issue(f, 'Your Seerr account is not linked or active.')) };
    }
    const cards: Discovery[] = [];
    const issues: DiscoveryIssue[] = candidates.slice(8).map(f => issue(f, 'The eight-title discovery limit was reached.'));
    // Bound catalogue traffic independently of paid research. No request POSTs.
    for (const finding of candidates.slice(0, 8)) {
        if (signal.aborted) throw new Error('Search cancelled.');
        try {
            const result = await lookupOne(api, finding, answer, signal, je, base, pages);
            if ('reason' in result) issues.push(issue(finding, result.reason));
            else cards.push(result);
        } catch (error) {
            if (signal.aborted) throw new Error('Search cancelled.');
            issues.push({ ...issue(finding, 'Seerr lookup could not complete. No automatic retry was attempted.'),
                details: searchFailureDetails(error) });
        }
    }
    return { cards, unresolved: issues.length, issues };
}

async function lookupOne(api: Api, finding: Finding, answer: SearchAnswer, signal: AbortSignal,
    je: Enhanced, base: string, pages: number): Promise<Discovery | { reason: string }> {
    if (finding.year == null) return { reason: 'The release year is missing; an exact identity could not be verified.' };
    const query = encodeURIComponent(finding.title);
    const raw = await cataloguePages(api, query, signal, pages, finding);
    if ('reason' in raw) return raw;
    const result = candidateForDetail(finding, raw);
    if (!result) return { reason: 'No unique exact title/year match was found in Seerr.' };
    if (je.hiddenContent && je.hiddenContent.filterJellyseerrResults([result], 'search').length === 0) {
        return { reason: 'Excluded by your visibility settings.' };
    }
    const kind = finding.kind === 'Movie' ? 'Movie' : 'Series';
    const id = result.id as number;
    const detail = await pluginRequest(api, `/JellyfinEnhanced/jellyseerr/${kind === 'Movie' ? 'movie' : 'tv'}/${id}`, signal);
    // Re-read the selected catalogue identity before exposing a request handoff.
    const mediaType = kind === 'Movie' ? 'movie' : 'tv';
    const confirmed = confirmDetail(finding, detail, mediaType, id);
    if ('reason' in confirmed) return confirmed;
    const url = seerrLink(base, kind, id);
    if (!url) return { reason: 'A valid Seerr detail link could not be constructed.' };
    const seasons = answer.resolutions.filter(r => r.status === 'unavailable')
        .map(r => answer.findings[r.candidateIndex]).filter(f => f.kind === 'Episode'
            && f.title === finding.title && f.year === finding.year && Number.isInteger(f.season) && Number(f.season) >= 0)
        .map(f => f.season as number);
    return { title: confirmed.title, year: finding.year as number, kind, id, url,
        matchEvidence: confirmed.evidence,
        posterPath: typeof result.posterPath === 'string' && /^\/[\w.-]+$/.test(result.posterPath) ?
            result.posterPath : undefined, seasons: [...new Set(seasons)].sort((a, b) => a - b) };
}

function canCheckVariant(finding: Finding, raw: unknown): boolean {
    return !!finding.imdbId && !finding.tmdbId && catalogueYearTypeMatches(finding, raw).length === 1;
}
function candidateForDetail(finding: Finding, raw: unknown): Record<string, unknown> | undefined {
    const exact = verifiedCatalogItem(finding, raw);
    if (exact) return exact;
    // Nomination alone never creates a card. Its detail must confirm the ID.
    return canCheckVariant(finding, raw) ? catalogueYearTypeMatches(finding, raw)[0] : undefined;
}
function providerIdsMatch(finding: Finding, detail: unknown, id: number): boolean {
    return (finding.tmdbId == null || id === finding.tmdbId)
        && (finding.imdbId == null || field(field(detail, 'externalIds'), 'imdbId') === finding.imdbId);
}
function detailIdentityMatches(finding: Finding, detail: unknown, mediaType: string, id: number): boolean {
    const detailYear = String(field(detail, mediaType === 'movie' ? 'releaseDate' : 'firstAirDate') ?? '').slice(0, 4);
    return field(detail, 'id') === id && (field(detail, 'mediaType') == null || field(detail, 'mediaType') === mediaType)
        && detailYear === String(finding.year);
}
function confirmDetail(finding: Finding, detail: unknown, mediaType: string, id: number):
{ title: string; evidence: 'title' | 'imdb' | 'tmdb' } | { reason: string } {
    if (!detailIdentityMatches(finding, detail, mediaType, id)) {
        return { reason: 'The Seerr detail page did not confirm the researched title and year.' };
    }
    if (!providerIdsMatch(finding, detail, id)) {
        return { reason: 'The Seerr detail page did not confirm the researched provider IDs. No title fallback was used.' };
    }
    if (!finding.imdbId && !finding.tmdbId
        && !verifiedCatalogItem(finding, { results: [{ ...(detail as object), mediaType }] })) {
        return { reason: 'The Seerr detail page did not confirm the researched title and year.' };
    }
    const canonicalTitle = field(detail, mediaType === 'movie' ? 'title' : 'name');
    if (typeof canonicalTitle !== 'string' || !canonicalTitle.trim() || canonicalTitle.length > 300) {
        return { reason: 'The Seerr detail page did not provide a valid title.' };
    }
    let evidence: 'title' | 'imdb' | 'tmdb' = 'title';
    if (finding.tmdbId) evidence = 'tmdb';
    if (finding.imdbId) evidence = 'imdb';
    return { title: canonicalTitle, evidence };
}

function examinedPageSelection(finding: Finding, results: unknown[]): { ready: boolean } | { reason: string } {
    const matches = exactCatalogMatches(finding, { results });
    if (matches.length > 1) return { reason: 'Multiple exact title/year/type matches were found; no identity was selected.' };
    return { ready: matches.length === 1 || canCheckVariant(finding, { results }) };
}

async function cataloguePages(api: Api, query: string, signal: AbortSignal,
    maxPages: number, finding: Finding): Promise<{ results: unknown[] } | { reason: string }> {
    // Search-ranked exact matches are accepted from the inspected pages after a
    // detail re-read. The fallback page cap never disqualifies a page-one match.
    // This is not a proof of uniqueness over the entire remote catalogue.
    // Default 49 GETs; the explicit ten-page setting permits at most 89 GETs.
    const results: unknown[] = [];
    const seen = new Set<string>();
    let pages = 1;
    let total: unknown;
    for (let page = 1; page <= Math.min(pages, maxPages); page++) {
        const raw = await pluginRequest(api, `/JellyfinEnhanced/jellyseerr/search?query=${query}&page=${page}`, signal);
        const parsed = cataloguePage(raw, page);
        if (!parsed) return { reason: 'Seerr returned an invalid or incomplete catalogue page.' };
        if (page === 1) {
            pages = parsed.pages;
            total = parsed.total;
        } else if (parsed.pages !== pages || parsed.total !== total) {
            return { reason: 'The catalogue changed between pages; no identity was selected.' };
        }
        if (!appendCatalogueRows(parsed.rows, results, seen)) return { reason: 'The catalogue contains invalid or repeated results.' };
        const selection = examinedPageSelection(finding, results);
        if ('reason' in selection) return selection;
        if (selection.ready) return { results };
    }
    if (pages > maxPages) return { reason: `No exact match was found in the first ${maxPages} of ${pages} pages; the configured fallback limit was reached.` };
    if (total !== undefined && total !== results.length) return { reason: 'The catalogue result count did not match its reported total.' };
    return { results };
}

function cataloguePage(raw: unknown, page: number): { pages: number; total: unknown; rows: unknown[] } | undefined {
    const pages = field(raw, 'totalPages') ?? 1;
    const rows = field(raw, 'results');
    const reportedPage = field(raw, 'page') ?? (pages === 1 ? 1 : undefined);
    const total = field(raw, 'totalResults');
    if (!Number.isSafeInteger(pages) || Number(pages) < 1
        || reportedPage !== page || !Array.isArray(rows) || rows.length > 20) return undefined;
    if (Number(pages) > 1 && total === undefined) return undefined;
    if (total !== undefined && (!Number.isSafeInteger(total) || Number(total) < 0
        || Math.max(1, Math.ceil(Number(total) / 20)) !== pages)) return undefined;
    if (page < Number(pages) && rows.length !== 20) return undefined;
    return { pages: Number(pages), total, rows };
}

function appendCatalogueRows(rows: unknown[], results: unknown[], seen: Set<string>): boolean {
    for (const row of rows) {
        const id = field(row, 'id');
        const kind = field(row, 'mediaType');
        if (!Number.isSafeInteger(id) || Number(id) < 1 || typeof kind !== 'string') return false;
        const key = `${kind}:${id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        results.push(row);
    }
    return true;
}
