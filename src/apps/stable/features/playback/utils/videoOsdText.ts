import type { ItemDto } from 'types/base/models/item-dto';

/** Omit filename-style placeholders only when they exactly repeat known metadata. */
function getEpisodeName(item: ItemDto, name: string) {
    if (item.ParentIndexNumber == null || item.IndexNumber == null) return name;

    let candidate = name.trim();
    if (item.SeriesName && candidate.toLowerCase().startsWith(item.SeriesName.toLowerCase())) {
        candidate = candidate.slice(item.SeriesName.length).replace(/^[\s._:-]+/, '');
    }
    const numbers = /^S(\d+):?E(\d+)(?:-E?(\d+))?$/i.exec(candidate);
    const lastEpisode = item.IndexNumberEnd ?? item.IndexNumber;
    if (numbers && Number(numbers[1]) === item.ParentIndexNumber
        && Number(numbers[2]) === item.IndexNumber
        && Number(numbers[3] ?? numbers[2]) === lastEpisode) {
        return '';
    }
    return name;
}

function getEpisodeDetail(item: ItemDto, name: string) {
    const season = item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : '';
    let episode = item.IndexNumber != null ? `E${item.IndexNumber}` : '';
    if (item.IndexNumber != null && item.IndexNumberEnd != null && item.IndexNumberEnd > item.IndexNumber) {
        episode += `-${item.IndexNumberEnd}`;
    }
    const numbers = [season, episode].filter(Boolean).join(':');
    return [numbers, getEpisodeName(item, name)].filter(Boolean).join(' - ');
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
