import { describe, expect, it } from 'vitest';
import { discoveryCandidates, parseAnswer, searchFailureMessage, seerrLink, verifiedCatalogItem } from './aiSearch';

const id = 'a'.repeat(32);
const finding = { Kind: 'Episode', Title: 'The Simpsons', Year: 1989, EpisodeTitle: 'Treehouse of Horror',
    Season: 2, Episode: 3, SourceIndices: [0] };
function response() {
    return { Research: { Findings: [finding], Resolutions: [{ CandidateIndex: 0, Status: 'matched', ItemIds: [id] }],
        ListComplete: false }, Items: [{ Id: id, Type: 'Episode', Name: 'Treehouse of Horror' }] };
}
describe('AI research routing', () => {
    it('preserves bounded optional provider IDs and rejects malformed values', () => {
        const raw = response();
        const withIds = (ids: object) => ({ ...raw, Research: { ...raw.Research,
            Findings: [{ ...finding, Kind: 'Movie', Title: 'Mulholland Dr.', Year: 2001, ...ids }] } });
        const movieRaw = { ...withIds({ ImdbId: 'tt0166924', TmdbId: 1018 }), Items: [{ Id: id, Type: 'Movie' }] };
        expect(parseAnswer(movieRaw).findings[0]).toMatchObject({ imdbId: 'tt0166924', tmdbId: 1018 });
        for (const ids of [{ ImdbId: 'invalid-id' }, { TmdbId: 0 }, { TmdbId: 2147483648 }]) {
            expect(() => parseAnswer(withIds(ids))).toThrow('Invalid finding');
        }
    });
    it('shows only fixed diagnostic codes/stages and a bounded HTTP status', () => {
        expect(searchFailureMessage({ response: { status: 502, data: { Code: 'incomplete_search',
            Diagnostics: { ValidationStage: 'search_status' } } } })).toContain('incomplete_search; HTTP 502; stage: search_status');
        expect(searchFailureMessage({ response: { status: 502, data: 'invalid_response' } })).toContain('invalid_response');
        const unsafe = searchFailureMessage({ message: 'private-token', response: { status: 502,
            data: { Code: 'private-code', Diagnostics: { ValidationStage: 'private-query' } }, headers: { Authorization: 'private-token' } } });
        expect(unsafe).not.toContain('private');
        expect(unsafe).toContain('HTTP 502');
        expect(searchFailureMessage({ response: { status: 403 } })).toContain('not permitted');
    });
    it('uses the server catalogue policy with a bounded legacy default', () => {
        expect(parseAnswer(response()).cataloguePageLimit).toBe(5);
        expect(parseAnswer({ ...response(), CataloguePageLimit: 10 }).cataloguePageLimit).toBe(10);
        expect(() => parseAnswer({ ...response(), CataloguePageLimit: 11 })).toThrow('Invalid catalogue page limit');
        expect(() => parseAnswer({ ...response(), CataloguePageLimit: '10' })).toThrow('Invalid catalogue page limit');
    });
    it('renders only real DTOs matched by the resolver', () => {
        expect(parseAnswer(response()).items[0].Id).toBe(id);
        const forged = response();
        forged.Items[0].Id = 'b'.repeat(32);
        expect(() => parseAnswer(forged)).toThrow('Unverified library card');
    });
    it('rejects duplicate, missing, and invalid candidate mappings', () => {
        const invalid = response();
        invalid.Research.Resolutions[0].CandidateIndex = 9;
        expect(() => parseAnswer(invalid)).toThrow();
        const duplicate = response();
        duplicate.Items.push(duplicate.Items[0]);
        expect(() => parseAnswer(duplicate)).toThrow();
    });
    it('normalizes host Guid resolution IDs against compact DTO IDs', () => {
        const result = response();
        result.Research.Resolutions[0].ItemIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
        expect(parseAnswer(result).items[0].Id).toBe(id);
        result.Items[0].Type = 'Movie';
        expect(() => parseAnswer(result)).toThrow('Unverified library card');
    });
    it('routes unavailable findings individually and deduplicates parent shows', () => {
        const mixed = response();
        mixed.Research.Findings.push({ ...finding, Season: 3 }, { ...finding, Title: 'Family Guy', Year: 1999 });
        mixed.Research.Resolutions.push({ CandidateIndex: 1, Status: 'unavailable', ItemIds: [] },
            { CandidateIndex: 2, Status: 'ambiguous', ItemIds: [] });
        const answer = parseAnswer(mixed);
        expect(discoveryCandidates(answer).map(f => f.title)).toEqual(['The Simpsons']);
        answer.findings.push({ ...answer.findings[1], season: 4 });
        answer.resolutions.push({ candidateIndex: 3, status: 'unavailable', itemIds: [] });
        expect(discoveryCandidates(answer)).toHaveLength(1);
    });
    it('verifies exact catalogue kind, title, year and ambiguity', () => {
        const movie = { kind: 'Movie' as const, title: 'A Few Good Men', year: 1992, sourceIndices: [0] };
        const match = { id: 881, mediaType: 'movie', title: movie.title, releaseDate: '1992-12-11' };
        expect(verifiedCatalogItem(movie, { results: [match] })?.id).toBe(881);
        expect(verifiedCatalogItem(movie, { results: [{ ...match, mediaType: 'tv' }] })).toBeUndefined();
        expect(verifiedCatalogItem(movie, { results: [match, { ...match, id: 882 }] })).toBeUndefined();
        expect(verifiedCatalogItem({ ...movie, year: null }, { results: [match] })).toBeUndefined();
    });
    it('uses only configured Seerr HTTP links with verified IDs', () => {
        expect(seerrLink('https://seerr.example/subpath/', 'Series', 456)).toBe('https://seerr.example/subpath/tv/456');
        // Deliberately invalid protocol fixture; never executed.
        // eslint-disable-next-line sonarjs/code-eval
        expect(seerrLink('javascript:alert(1)', 'Movie', 881)).toBeUndefined();
        expect(seerrLink('https://secret@example.com', 'Movie', 881)).toBeUndefined();
        expect(seerrLink('https://seerr.example', 'Movie', -1)).toBeUndefined();
    });
});
