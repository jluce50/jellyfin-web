import type { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounceValue } from 'usehooks-ts';

import SearchFields from 'apps/stable/features/search/components/SearchFields';
import SearchResults from 'apps/stable/features/search/components/SearchResults';
import SearchSuggestions from 'apps/stable/features/search/components/SearchSuggestions';
import Page from 'components/Page';
import useSearchParam from 'hooks/useSearchParam';
import globalize from 'lib/globalize';
import { useApi } from 'hooks/useApi';
import AiSearch from '../features/search/components/AiSearch';
import { compatibleSearchHooks, pluginRequest } from '../features/search/aiSearchClient';
import { field } from '../features/search/aiSearch';

const COLLECTION_TYPE_PARAM = 'collectionType';
const PARENT_ID_PARAM = 'parentId';
const QUERY_PARAM = 'query';

const Search: FC = () => {
    const [searchParams] = useSearchParams();
    const parentIdQuery = searchParams.get(PARENT_ID_PARAM) || undefined;
    const collectionTypeQuery = (searchParams.get(COLLECTION_TYPE_PARAM) || undefined) as CollectionType | undefined;
    const [ query, setQuery ] = useSearchParam(QUERY_PARAM);
    const [debouncedQuery] = useDebounceValue(query, 500);
    const { api, user } = useApi();
    const [ aiMode, setAiMode ] = useState(false);
    const [ availability, setAvailability ] = useState<{ api: typeof api; userId: string;
        researchEnabled: boolean }>();
    const openAi = useCallback(() => setAiMode(true), []);
    const openLibrary = useCallback(() => setAiMode(false), []);
    useEffect(() => {
        setAiMode(false);
        setAvailability(undefined);
        if (!api || !user?.Id || parentIdQuery || collectionTypeQuery) return;
        if (typeof AbortController === 'undefined' || typeof URL === 'undefined') return;
        // Runtime-gated above; older clients retain their existing search.
        // eslint-disable-next-line compat/compat
        const controller = new AbortController();
        const userId = user.Id;
        // Read-only availability is the only automatic plugin call. No research.
        pluginRequest(api, '/Plugins/LuceSearchAi/Availability', controller.signal)
            .then(result => {
                if (!controller.signal.aborted && field(result, 'available') === true
                    && field(result, 'contractVersion') === 2 && compatibleSearchHooks()) {
                    setAvailability({ api, userId, researchEnabled: field(result, 'researchEnabled') === true });
                }
            }).catch(() => { /* Absent, denied, or incompatible plugin leaves ordinary search. */ });
        return () => controller.abort();
    }, [ api, user?.Id, parentIdQuery, collectionTypeQuery ]);
    const allowed = availability?.api === api && availability?.userId === user?.Id && !!api
        && !parentIdQuery && !collectionTypeQuery;
    const showAi = aiMode && allowed;

    return (
        <>
            <Page
                id='searchPage'
                title={globalize.translate('Search')}
                className={`mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage${showAi ? ' hide' : ''}`}
            >
                {allowed && <div className='padded-left padded-right'>
                    <button type='button' className='emby-button' onClick={openAi}>AI search</button>
                </div>}
                <SearchFields query={query} onSearch={setQuery} />
                {!debouncedQuery ? (
                    <SearchSuggestions
                        parentId={parentIdQuery}
                    />
                ) : (
                    <SearchResults
                        parentId={parentIdQuery}
                        collectionType={collectionTypeQuery}
                        query={debouncedQuery}
                    />
                )}
            </Page>
            {showAi && api && <div id='luceAiSearchPage' className='page mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage'>
                <AiSearch key={`${api.basePath}:${user?.Id}`} api={api}
                    researchEnabled={availability?.researchEnabled === true} onLibrary={openLibrary} />
            </div>}
        </>
    );
};

export default Search;
