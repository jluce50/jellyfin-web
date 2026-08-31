import { describe, expect, it } from 'vitest';

import type { ItemDto } from 'types/base/models/item-dto';

import { getVideoOsdText } from './videoOsdText';

const episode: ItemDto = {
    Type: 'Episode',
    SeriesName: 'Brooklyn Nine-Nine',
    Name: 'Cop-Con',
    ParentIndexNumber: 4,
    IndexNumber: 17
};

describe('getVideoOsdText', () => {
    it('separates the series from the episode details', () => {
        expect(getVideoOsdText(episode)).toEqual({ title: 'Brooklyn Nine-Nine', detail: 'S4:E17 - Cop-Con' });
    });

    it.each(['Brooklyn Nine-Nine S01E19', 'Brooklyn Nine-Nine - S1:E19', 'brooklyn nine-nine.s01e19', 'S01E19'])('omits a redundant filename-style title: %s', Name => {
        expect(getVideoOsdText({ ...episode, Name, ParentIndexNumber: 1, IndexNumber: 19 }))
            .toEqual({ title: 'Brooklyn Nine-Nine', detail: 'S1:E19' });
    });

    it.each(['Tactical Village', 'Brooklyn Nine-Nine: A Celebration', 'Brooklyn Nine-Nine S01E18', 'Brooklyn Nine-Nine S01E19 - Tactical Village'])('preserves descriptive or nonmatching titles: %s', Name => {
        expect(getVideoOsdText({ ...episode, Name, ParentIndexNumber: 1, IndexNumber: 19 }).detail)
            .toBe(`S1:E19 - ${Name}`);
    });

    it('only omits a multi-episode placeholder when the whole range matches', () => {
        const item = { ...episode, Name: 'Brooklyn Nine-Nine S04E17-E18', IndexNumberEnd: 18 };
        expect(getVideoOsdText(item).detail).toBe('S4:E17-18');
        expect(getVideoOsdText({ ...item, IndexNumberEnd: 19 }).detail).toBe('S4:E17-19 - Brooklyn Nine-Nine S04E17-E18');
    });

    it('preserves placeholder text when metadata is incomplete', () => {
        expect(getVideoOsdText({ ...episode, Name: 'S01E19', ParentIndexNumber: null }).detail).toBe('E17 - S01E19');
    });

    it.each([
        [{ ParentIndexNumber: 0 }, 'S0:E17 - Cop-Con'],
        [{ IndexNumberEnd: 18 }, 'S4:E17-18 - Cop-Con'],
        [{ IndexNumberEnd: 16 }, 'S4:E17 - Cop-Con'],
        [{ ParentIndexNumber: null }, 'E17 - Cop-Con'],
        [{ IndexNumber: null }, 'S4 - Cop-Con'],
        [{ ParentIndexNumber: null, IndexNumber: null }, 'Cop-Con'],
        [{ Name: null }, 'S4:E17']
    ] as [Partial<ItemDto>, string][])('handles partial episode metadata: %j', (overrides, detail) => {
        expect(getVideoOsdText({ ...episode, ...overrides })).toEqual({ title: 'Brooklyn Nine-Nine', detail });
    });

    it('uses episode details alone when the series name is missing', () => {
        expect(getVideoOsdText({ ...episode, SeriesName: null })).toEqual({ title: 'S4:E17 - Cop-Con', detail: '' });
    });

    it.each([undefined, null, {}, { Type: 'Episode' } as ItemDto])('returns empty text for an unidentified item: %j', item => {
        expect(getVideoOsdText(item)).toEqual({ title: '', detail: '' });
    });

    it('shows a movie title and optional year without episode details', () => {
        expect(getVideoOsdText({ Type: 'Movie', Name: 'Arrival', ProductionYear: 2016 })).toEqual({ title: 'Arrival (2016)', detail: '' });
        expect(getVideoOsdText({ Type: 'Movie', Name: 'Arrival' })).toEqual({ title: 'Arrival', detail: '' });
    });

    it.each(['Program', 'Recording'] as const)('uses the episode title for a %s', Type => {
        expect(getVideoOsdText({ ...episode, Type, Name: 'Brooklyn Nine-Nine', SeriesName: null, EpisodeTitle: 'Cop-Con', IsSeries: true }))
            .toEqual({ title: 'Brooklyn Nine-Nine', detail: 'S4:E17 - Cop-Con' });
    });

    it('shows live TV without episode metadata and the channel when no program is available', () => {
        expect(getVideoOsdText({ Type: 'Program', Name: 'Evening News' })).toEqual({ title: 'Evening News', detail: '' });
        expect(getVideoOsdText({ Type: 'Program', Name: 'A Series', IsSeries: true })).toEqual({ title: 'A Series', detail: '' });
        expect(getVideoOsdText({ Type: 'TvChannel', Name: 'Channel', ChannelNumber: '5.1' })).toEqual({ title: '5.1 Channel', detail: '' });
    });

    it('does not invent episode numbers for music videos', () => {
        expect(getVideoOsdText({ Type: 'MusicVideo', Name: 'Music video', IndexNumber: 2 })).toEqual({ title: 'Music video', detail: '' });
    });
});
