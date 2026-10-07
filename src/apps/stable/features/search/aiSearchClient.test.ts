/* eslint-disable compat/compat -- These checks run in JSDOM with AbortController support. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '@jellyfin/sdk';
import { compatibleSearchHooks, lookupDiscovery, pluginRequest } from './aiSearchClient';
import type { SearchAnswer } from './aiSearch';

const fixture: SearchAnswer = { findings: [{ kind: 'Episode', title: 'The Simpsons', year: 1989,
    episodeTitle: 'Missing special', season: 0, sourceIndices: [0] }],
resolutions: [{ candidateIndex: 0, status: 'unavailable', itemIds: [] }], items: [], listComplete: false };
const item = { id: 456, name: 'The Simpsons', firstAirDate: '1989-12-17', mediaType: 'tv', posterPath: '/poster.jpg' };
function catalogueReply(url: string, results: unknown[], detail: unknown) {
    if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
    if (url.includes('/search?')) return { data: { page: 1, totalPages: 1, totalResults: results.length, results } };
    return { data: detail };
}
function setup(hidden = false) {
    const request = vi.fn(async ({ url }: { url: string }): Promise<{ data: unknown }> => {
        if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
        if (url.includes('/search?')) return { data: { results: [item] } };
        return { data: item };
    });
    const api = { axiosInstance: { request }, getUri: (path: string) => `https://jellyfin.example/base${path}`,
        authorizationHeader: 'test-auth' } as unknown as Api;
    // Plugin version fixture, not an IP address.
    // eslint-disable-next-line sonarjs/no-hardcoded-ip
    Object.assign(window, { JellyfinEnhanced: { pluginVersion: '12.11.0.0',
        jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'https://seerr.example' },
        hiddenContent: { filterJellyseerrResults: (results: unknown[]) => hidden ? [] : results } } });
    return { api, request };
}
afterEach(() => {
    delete (window as Window & { JellyfinEnhanced?: unknown }).JellyfinEnhanced;
    document.body.innerHTML = '';
});

describe('Read-only Seerr handoff', () => {
    it('verifies a title variant by IMDb identity and excludes its TV namesake', async () => {
        const { api, request } = setup();
        const movie = { id: 1018, mediaType: 'movie', title: 'Mulholland Drive', releaseDate: '2001-06-06' };
        request.mockImplementation(async ({ url }) => catalogueReply(url, [
            { id: 325218, mediaType: 'tv', name: 'Mulholland Dr.', firstAirDate: '' }, movie ],
        { ...movie, externalIds: { imdbId: 'tt0166924' } }));
        const answer: SearchAnswer = { ...fixture, findings: [{ kind: 'Movie', title: 'Mulholland Dr.', year: 2001,
            imdbId: 'tt0166924', sourceIndices: [0] }] };
        const result = await lookupDiscovery(api, answer, new AbortController().signal);
        expect(result.cards).toMatchObject([{ id: 1018, title: 'Mulholland Drive', url: 'https://seerr.example/movie/1018', matchEvidence: 'imdb' }]);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.every(([config]) => (config as { method?: string }).method === 'GET')).toBe(true);
        expect((await lookupDiscovery(api, { ...answer, findings: [{ ...answer.findings[0], imdbId: null }] },
            new AbortController().signal)).cards).toEqual([]);
        for (const badDetail of [{ ...movie, externalIds: { imdbId: 'tt9999999' } },
            { ...movie, id: 999, externalIds: { imdbId: 'tt0166924' } },
            { ...movie, releaseDate: '2002-01-01', externalIds: { imdbId: 'tt0166924' } },
            { ...movie, mediaType: 'tv', externalIds: { imdbId: 'tt0166924' } }]) {
            request.mockImplementation(async ({ url }) => catalogueReply(url, [movie], badDetail));
            expect((await lookupDiscovery(api, answer, new AbortController().signal)).cards).toEqual([]);
        }
    });
    it('requires all supplied IDs and refuses ambiguous IMDb variant nominations', async () => {
        const { api, request } = setup();
        const movie = { id: 1018, mediaType: 'movie', title: 'Mulholland Drive', releaseDate: '2001-06-06' };
        const answer: SearchAnswer = { ...fixture, findings: [{ kind: 'Movie', title: 'Mulholland Dr.', year: 2001,
            tmdbId: 1018, imdbId: 'tt0166924', sourceIndices: [0] }] };
        request.mockImplementation(async ({ url }) => catalogueReply(url, [movie], { ...movie, externalIds: { imdbId: 'tt9999999' } }));
        expect((await lookupDiscovery(api, answer, new AbortController().signal)).cards).toEqual([]);
        request.mockImplementation(async ({ url }) => catalogueReply(url, [movie, { ...movie, id: 444, title: 'Different film' }], movie));
        request.mockClear();
        expect((await lookupDiscovery(api, { ...answer, findings: [{ ...answer.findings[0], tmdbId: null }] },
            new AbortController().signal)).cards).toEqual([]);
        expect(request).toHaveBeenCalledTimes(2); // No detail read without a unique candidate.
    });
    it('allows the supported server research deadline plus matching time without lengthening catalogue reads', async () => {
        const { api, request } = setup();
        const signal = new AbortController().signal;
        await pluginRequest(api, '/Plugins/LuceSearchAi/Search', signal, { Query: 'Synthetic query' });
        expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', timeout: 210000, signal }));
        await pluginRequest(api, '/Plugins/LuceSearchAi/Availability', signal);
        expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'GET', timeout: 15000, signal }));
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('re-reads exact identity and exposes a season-zero handoff without a request POST', async () => {
        const { api, request } = setup();
        const result = await lookupDiscovery(api, fixture, new AbortController().signal);
        expect(result.cards[0]).toMatchObject({ url: 'https://seerr.example/tv/456', seasons: [0] });
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.every(([config]) => (config as { method?: string }).method === 'GET')).toBe(true);
    });
    it('respects hidden-content filtering without obtaining or rendering detail', async () => {
        const { api, request } = setup(true);
        expect((await lookupDiscovery(api, fixture, new AbortController().signal)).cards).toEqual([]);
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('does not retry failed catalogue requests', async () => {
        const { api, request } = setup();
        request.mockRejectedValueOnce(new Error('Unavailable'));
        await expect(lookupDiscovery(api, fixture, new AbortController().signal)).rejects.toThrow();
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('fails closed on unknown search hook versions', () => {
        setup();
        expect(compatibleSearchHooks()).toBe(true);
        const script = document.createElement('script');
        script.src = 'https://cdn.example/gh/ranaldsgift/KefinTweaks@v0.5.0/scripts/search.js';
        document.body.appendChild(script);
        expect(compatibleSearchHooks()).toBe(false);
    });
    it.each([
        ['Bad Boys', 1995, 9737, 5, 83],
        ['Rush Hour', 1998, 2109, 2, 28],
        ['Snatch', 2000, 107, 8, 154]
    ])('accepts page-one %s despite a larger catalogue and verifies details without more search pages', async (title, year, id, pages, total) => {
        const { api, request } = setup();
        const movie = { id, title, mediaType: 'movie', releaseDate: `${year}-01-01` };
        const rows = Array.from({ length: Number(total) }, (_, i) => i === 0 ? movie :
            { id: 20000 + i, title: `Other ${i}`, mediaType: 'movie', releaseDate: '2000-01-01' });
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            if (url.includes('/search?')) {
                const page = Number(new URL(url).searchParams.get('page'));
                return { data: { page, totalPages: pages, totalResults: total, results: rows.slice((page - 1) * 20, page * 20) } };
            }
            return { data: movie };
        });
        const answer = { ...fixture, cataloguePageLimit: 5,
            findings: [{ kind: 'Movie' as const, title: String(title), year: Number(year), sourceIndices: [0] }] };
        const result = await lookupDiscovery(api, answer, new AbortController().signal);
        expect(result.cards[0]).toMatchObject({ title, id, year });
        expect(result.unresolved).toBe(0);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.every(([config]) => (config as { method?: string }).method === 'GET')).toBe(true);
    });
    it.each(['duplicate', 'changed-total', 'wrong-page', 'ambiguous'])('rejects %s catalogue pagination before exposing a detail link', async mode => {
        const { api, request } = setup();
        const first = Array.from({ length: 20 }, (_, i) =>
            ({ id: 30000 + i, name: `Other ${i}`, mediaType: 'tv', firstAirDate: '2000-01-01' }));
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            const page = Number(new URL(url).searchParams.get('page'));
            const second = mode === 'duplicate' ? [first[0]] : [item];
            if (mode === 'ambiguous') second.push({ ...item, id: 999 });
            return { data: { page: mode === 'wrong-page' ? 1 : page,
                totalPages: 2, totalResults: mode === 'ambiguous' || (mode === 'changed-total' && page === 2) ? 22 : 21,
                results: page === 1 ? first : second } };
        });
        const result = await lookupDiscovery(api, fixture, new AbortController().signal);
        expect(result.cards).toEqual([]);
        expect(result.unresolved).toBe(1);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it('reaches the configured fallback bound only when no examined page has an exact match', async () => {
        const { api, request } = setup();
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            const page = Number(new URL(url).searchParams.get('page'));
            return { data: { page, totalPages: 6, totalResults: 101,
                results: Array.from({ length: 20 }, (_, i) => ({ ...item, id: page * 1000 + i, name: `Other ${page}:${i}` })) } };
        });
        const result = await lookupDiscovery(api, fixture, new AbortController().signal);
        expect(result.cards).toEqual([]);
        expect(result.issues?.[0]).toMatchObject({ title: 'The Simpsons', reason: 'No exact match was found in the first 5 of 6 pages; the configured fallback limit was reached.' });
        expect(request).toHaveBeenCalledTimes(6);
    });
    it('searches a later page only when page one has no exact match', async () => {
        const { api, request } = setup();
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            if (!url.includes('/search?')) return { data: item };
            const page = Number(new URL(url).searchParams.get('page'));
            return { data: { page, totalPages: 8, totalResults: 154,
                results: Array.from({ length: 20 }, (_, i) => page === 2 && i === 0 ? item :
                    ({ ...item, id: page * 1000 + i, name: `Other ${page}:${i}` })) } };
        });
        expect((await lookupDiscovery(api, fixture, new AbortController().signal)).cards).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(4);
    });
    it('selects the exact match rather than a higher-ranked wrong type or year', async () => {
        const { api, request } = setup();
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            if (url.includes('/search?')) {
                return { data: { results: [
                    { ...item, id: 111, mediaType: 'movie' }, { ...item, id: 222, firstAirDate: '2000-01-01' }, item
                ] } };
            }
            return { data: item };
        });
        expect((await lookupDiscovery(api, fixture, new AbortController().signal)).cards[0].id).toBe(456);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it.each(['ambiguous', 'wrong-id', 'wrong-year', 'wrong-type'])('rejects %s rather than trusting first-result position', async mode => {
        const { api, request } = setup();
        request.mockImplementation(async ({ url }) => {
            if (url.endsWith('user-status')) return { data: { active: true, userFound: true } };
            if (url.includes('/search?')) return { data: { results: mode === 'ambiguous' ? [item, { ...item, id: 999 }] : [item] } };
            if (mode === 'wrong-id') return { data: { ...item, id: 999 } };
            if (mode === 'wrong-year') return { data: { ...item, firstAirDate: '2000-01-01' } };
            return { data: { ...item, mediaType: 'movie' } };
        });
        expect((await lookupDiscovery(api, fixture, new AbortController().signal)).cards).toEqual([]);
        expect(request).toHaveBeenCalledTimes(mode === 'ambiguous' ? 2 : 3);
    });
    it('rejects a bypassed or out-of-range page policy before catalogue traffic', async () => {
        const { api, request } = setup();
        await expect(lookupDiscovery(api, { ...fixture, cataloguePageLimit: 11 }, new AbortController().signal)).rejects.toThrow('Invalid catalogue page limit');
        expect(request).not.toHaveBeenCalled();
    });
});
/* eslint-enable compat/compat */
