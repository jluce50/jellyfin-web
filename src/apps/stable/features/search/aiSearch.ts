import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';

export interface Finding {
    kind: 'Episode' | 'Movie' | 'Series';
    title: string;
    year: number | null;
    episodeTitle?: string | null;
    season?: number | null;
    episode?: number | null;
    sourceIndices: number[];
    imdbId?: string | null;
    tmdbId?: number | null;
}
export interface Resolution { candidateIndex: number; status: string; itemIds: string[] }
export interface SearchAnswer {
    findings: Finding[];
    resolutions: Resolution[];
    items: BaseItemDto[];
    clarification?: string | null;
    listComplete: boolean;
    researchLimited?: boolean;
    cataloguePageLimit?: number;
}
export interface Discovery {
    title: string;
    year: number;
    kind: 'Movie' | 'Series';
    id: number;
    posterPath?: string;
    url: string;
    seasons: number[];
    matchEvidence?: 'title' | 'imdb' | 'tmdb';
}
export interface DiscoveryIssue { kind: Finding['kind']; title: string; year: number | null; reason: string; details?: string }

const failureMessages = new Map([
    ['incomplete_search', 'A web research step did not finish.'],
    ['incomplete_response', 'The AI response was incomplete.'],
    ['invalid_response', 'The AI response failed validation.'],
    ['unverified_sources', 'The cited sources could not be verified against completed research.'],
    ['refused', 'The AI provider declined this request.'],
    ['timed_out', 'AI research reached its timeout.'],
    ['network_error', 'The server could not connect to the AI provider.'],
    ['rate_limited', 'The AI provider rate limit was reached.'],
    ['upstream_rejected', 'The AI provider rejected the request.'],
    ['response_too_large', 'The AI response exceeded the size limit.'],
    ['credentials_missing', 'The server research credential is unavailable.'],
    ['settings_invalid', 'The server research settings are invalid.'],
    ['research_disabled', 'AI research is disabled.'],
    ['research_busy', 'Another research request is already running.']
]);
const failureStages = new Set(['response_json', 'response_envelope', 'output_item', 'search_status',
    'search_sources', 'message_content', 'message_annotations', 'output_text_count', 'structured_output',
    'candidate_shape', 'candidate_validation', 'source_provenance']);

export function searchFailureMessage(error: unknown): string {
    const response = field(error, 'response');
    const data = field(response, 'data');
    const code = typeof data === 'string' ? data : field(data, 'code');
    const rawStatus = field(response, 'status');
    const status = Number.isInteger(rawStatus) && Number(rawStatus) >= 100 && Number(rawStatus) <= 599 ? rawStatus : undefined;
    if (typeof code === 'string' && failureMessages.has(code)) {
        const rawStage = field(field(data, 'diagnostics'), 'validationStage');
        const details = [code];
        if (status) details.push(`HTTP ${status}`);
        if (typeof rawStage === 'string' && failureStages.has(rawStage)) details.push(`stage: ${rawStage}`);
        return `${failureMessages.get(code)} (${details.join('; ')}) No automatic retry was attempted.`;
    }
    if (status === 401 || status === 403) return 'This session is not permitted to run AI research. No automatic retry was attempted.';
    const suffix = status ? ` (HTTP ${status})` : '';
    return `AI search could not complete${suffix}. No automatic retry was attempted.`;
}

// Render diagnostic fields as text, never the Axios request/config or headers.
export function searchFailureDetails(error: unknown): string {
    const response = field(error, 'response');
    const data = field(response, 'data');
    const redact = (value: string) => value
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
        .replace(/("(?:api[_-]?key|password|secret|token|access_token|authorization)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
        .replace(/([?&](?:api[_-]?key|key|token|access_token|password|secret|authorization)=)[^&#\s]*/gi, '$1[redacted]');
    const details: Record<string, unknown> = { automaticRetry: false };
    const status = field(response, 'status');
    if (Number.isInteger(status)) details.httpStatus = status;
    const code = typeof data === 'string' ? data : field(data, 'code');
    if (typeof code === 'string') details.code = redact(code);
    for (const name of ['message', 'error']) {
        const value = field(data, name);
        if (typeof value === 'string') details[name] = redact(value);
    }
    const diagnostics = field(data, 'diagnostics');
    if (diagnostics && typeof diagnostics === 'object') {
        // Preserve new server diagnostic fields automatically. Never traverse the
        // Axios request/config; redact sensitive fields recursively within data.
        details.diagnostics = JSON.parse(JSON.stringify(diagnostics, (name, value) => {
            if (/^(?:headers|authorization|password|api[_-]?key|access[_-]?token|token|secret)$/i.test(name)) return '[redacted]';
            return typeof value === 'string' ? redact(value) : value;
        }));
    }
    if (!response && error instanceof Error) details.message = redact(error.message);
    return JSON.stringify(details, null, 2);
}

// Host DTOs use PascalCase; plugin JSON casing depends on host serializer settings.
export function field(value: unknown, name: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return record[name] ?? record[name.charAt(0).toUpperCase() + name.slice(1)];
}
function array(value: unknown): unknown[] {
    if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid search response.');
    return value;
}
function normalizedId(id: unknown): string | undefined {
    if (typeof id !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id)) return undefined;
    return id.replace(/-/g, '').toLowerCase();
}
export function parseAnswer(raw: unknown): SearchAnswer {
    const research = field(raw, 'research');
    const findings = array(field(research, 'findings')).map(value => {
        const kind = field(value, 'kind');
        const title = field(value, 'title');
        const year = field(value, 'year');
        const imdbId = field(value, 'imdbId');
        const tmdbId = field(value, 'tmdbId');
        if (!['Movie', 'Series', 'Episode'].includes(String(kind)) || typeof title !== 'string'
            || !title.trim() || title.length > 300
            || (year != null && (!Number.isInteger(year) || Number(year) < 1800 || Number(year) > 2200))
            || (imdbId != null && (typeof imdbId !== 'string' || imdbId.length > 30 || !/^tt\d+$/.test(imdbId)))
            || (tmdbId != null && (!Number.isSafeInteger(tmdbId) || Number(tmdbId) < 1 || Number(tmdbId) > 2147483647))) {
            throw new Error('Invalid finding.');
        }
        return { kind, title, year: year ?? null, episodeTitle: field(value, 'episodeTitle'),
            season: field(value, 'season'), episode: field(value, 'episode'),
            sourceIndices: array(field(value, 'sourceIndices')), imdbId, tmdbId } as Finding;
    });
    const resolutions = array(field(research, 'resolutions')).map(value => {
        const candidateIndex = field(value, 'candidateIndex');
        const status = field(value, 'status');
        const itemIds = array(field(value, 'itemIds')).map(normalizedId);
        if (!Number.isInteger(candidateIndex) || Number(candidateIndex) < 0 || Number(candidateIndex) >= findings.length
            || !['matched', 'unavailable', 'ambiguous', 'insufficient_evidence'].includes(String(status))
            || itemIds.some(id => !id) || (status === 'matched' ? itemIds.length !== 1 : itemIds.length !== 0)) {
            throw new Error('Invalid resolution.');
        }
        return { candidateIndex, status, itemIds } as Resolution;
    });
    if (resolutions.length !== findings.length || new Set(resolutions.map(r => r.candidateIndex)).size !== findings.length) {
        throw new Error('Incomplete search response.');
    }
    const ids = new Set(resolutions.flatMap(r => r.itemIds).map(id => id.toLowerCase()));
    const items = (array(field(raw, 'items')) as BaseItemDto[]).map(item => ({ ...item, Id: normalizedId(item.Id) }));
    if (items.some(item => !item.Id || !ids.has(item.Id)
        || !['Movie', 'Series', 'Episode'].includes(String(item.Type))
        || resolutions.some(r => r.itemIds.includes(item.Id as string) && findings[r.candidateIndex].kind !== item.Type))
        || new Set(items.map(item => item.Id)).size !== items.length || ids.size !== items.length) {
        throw new Error('Unverified library card.');
    }
    const clarification = field(research, 'clarification');
    if (clarification != null && (typeof clarification !== 'string' || clarification.length > 2000)) {
        throw new Error('Invalid clarification.');
    }
    const cataloguePageLimit = field(raw, 'cataloguePageLimit') ?? 5;
    if (!Number.isInteger(cataloguePageLimit) || Number(cataloguePageLimit) < 1 || Number(cataloguePageLimit) > 10) {
        throw new Error('Invalid catalogue page limit.');
    }
    return { findings, resolutions, items, clarification: clarification as string | null,
        listComplete: field(research, 'listComplete') === true,
        researchLimited: field(research, 'researchLimited') === true,
        cataloguePageLimit: Number(cataloguePageLimit) };
}

export function discoveryCandidates(answer: SearchAnswer): Finding[] {
    const candidates = answer.resolutions.filter(r => r.status === 'unavailable')
        .map(r => answer.findings[r.candidateIndex]);
    // Group episodes by their parent series. Preserve all relevant seasons below.
    return candidates.filter((item, i) => candidates.findIndex(other =>
        other.title === item.title && other.year === item.year
        && (other.kind === 'Movie') === (item.kind === 'Movie')) === i);
}

export function verifiedCatalogItem(finding: Finding, raw: unknown): Record<string, unknown> | undefined {
    const matches = exactCatalogMatches(finding, raw);
    return matches.length === 1 ? matches[0] : undefined;
}

export function exactCatalogMatches(finding: Finding, raw: unknown): Record<string, unknown>[] {
    const type = finding.kind === 'Movie' ? 'movie' : 'tv';
    if (finding.year == null) return []; // A missing year needs disambiguation.
    const results = field(raw, 'results');
    if (!Array.isArray(results)) return [];
    const matches = results.filter(item => item?.mediaType === type && Number.isSafeInteger(item.id) && item.id > 0
        && (finding.tmdbId != null ? item.id === finding.tmdbId :
            String(item.title ?? item.name ?? '').trim().toLowerCase() === finding.title.trim().toLowerCase())
        && String(item.releaseDate ?? item.firstAirDate ?? '').slice(0, 4) === String(finding.year));
    const unique = [...new Map(matches.map(item => [item.id, item])).values()];
    return unique;
}

export function catalogueYearTypeMatches(finding: Finding, raw: unknown): Record<string, unknown>[] {
    const results = field(raw, 'results');
    if (!Array.isArray(results) || finding.year == null) return [];
    const type = finding.kind === 'Movie' ? 'movie' : 'tv';
    return [...new Map(results.filter(item => item?.mediaType === type && Number.isSafeInteger(item.id) && item.id > 0
        && String(item.releaseDate ?? item.firstAirDate ?? '').slice(0, 4) === String(finding.year))
        .map(item => [item.id, item])).values()];
}

export function seerrLink(base: string, kind: 'Movie' | 'Series', id: number): string | undefined {
    try {
        // Availability is gated on URL support; this also fails closed if absent.
        // eslint-disable-next-line compat/compat
        const url = new URL(base);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
            || !Number.isSafeInteger(id) || id < 1) return undefined;
        url.search = '';
        url.hash = '';
        url.pathname = `${url.pathname.replace(/\/$/, '')}/${kind === 'Movie' ? 'movie' : 'tv'}/${id}`;
        return url.href;
    } catch { return undefined; }
}
