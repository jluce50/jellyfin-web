import type { ItemDto } from 'types/base/models/item-dto';

function getEpisodeDetail(item: ItemDto, name: string) {
    const season = item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : '';
    let episode = item.IndexNumber != null ? `E${item.IndexNumber}` : '';
    if (item.IndexNumber != null && item.IndexNumberEnd != null && item.IndexNumberEnd > item.IndexNumber) {
        episode += `-${item.IndexNumberEnd}`;
    }
    const numbers = [season, episode].filter(Boolean).join(':');
    return [numbers, name].filter(Boolean).join(' - ');
}

/** Text for the optional title above the video progress bar. */
export function getVideoOsdText(item?: ItemDto | null) {
    if (!item) return { title: '', detail: '' };

    const isProgram = item.Type === 'Program' || item.Type === 'Recording';
    const isEpisode = item.Type === 'Episode' || (isProgram && (item.IsSeries || !!item.EpisodeTitle));

    if (isEpisode) {
        const seriesName = (isProgram ? item.Name : item.SeriesName) || '';
        const episodeName = (isProgram ? item.EpisodeTitle : item.Name) || '';
        const detail = getEpisodeDetail(item, episodeName);

        return seriesName ?
            { title: seriesName, detail } :
            { title: detail, detail: '' };
    }

    let title = item.Name || '';
    if (title && item.Type === 'Movie' && item.ProductionYear) {
        title += ` (${item.ProductionYear})`;
    }
    if (item.Type === 'TvChannel' && item.ChannelNumber) {
        title = [item.ChannelNumber, title].filter(Boolean).join(' ');
    }

    return { title, detail: '' };
}
