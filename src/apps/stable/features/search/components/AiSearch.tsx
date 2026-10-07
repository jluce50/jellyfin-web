import type { Api } from '@jellyfin/sdk';
import React, { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { CardShape } from '../../../../../utils/card';
import { parseAnswer, searchFailureDetails, searchFailureMessage, type Discovery, type DiscoveryIssue, type SearchAnswer } from '../aiSearch';
import { compatibleSearchHooks, lookupDiscovery, pluginRequest } from '../aiSearchClient';
import SearchResultsRow from './SearchResultsRow';
import './aisearch.scss';

const cardOptions = { shape: CardShape.AutoOverflow, scalable: true, showTitle: true,
    coverImage: true, showParentTitle: true, centerText: true, allowBottomPadding: false };

interface Props { api: Api; researchEnabled: boolean; onLibrary: () => void }
const rowTitles = { Movie: 'Movies', Series: 'TV Shows', Episode: 'Episodes' };
const evidenceLabels = { title: 'Title/year/type matched; Seerr ID confirmed.',
    imdb: 'IMDb ID, year and type confirmed.', tmdb: 'TMDB ID, year and type confirmed.' };
const AiSearch = ({ api, researchEnabled, onLibrary }: Props) => {
    const [ draft, setDraft ] = useState('');
    const [ answer, setAnswer ] = useState<SearchAnswer>();
    const [ discovery, setDiscovery ] = useState<Discovery[]>([]);
    const [ issues, setIssues ] = useState<DiscoveryIssue[]>([]);
    const [ pending, setPending ] = useState(false);
    const [ message, setMessage ] = useState('');
    const [ failureDetails, setFailureDetails ] = useState('');
    const request = useRef<AbortController>();

    useEffect(() => () => request.current?.abort(), []);
    const cancel = useCallback(() => {
        request.current?.abort();
        request.current = undefined;
        setPending(false);
        setMessage('Search cancelled. Research already started may still incur charges.');
        setFailureDetails('');
    }, []);
    const changeDraft = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        setAnswer(undefined);
        setDiscovery([]);
        setIssues([]);
        setMessage('');
        setFailureDetails('');
    }, []);
    const submit = useCallback(async (event: FormEvent) => {
        event.preventDefault();
        if (request.current || !researchEnabled || !draft.trim() || !compatibleSearchHooks()) return;
        // Modern-browser-only extension; legacy clients retain Library search.
        // eslint-disable-next-line compat/compat
        const controller = new AbortController();
        request.current = controller;
        const current = () => request.current === controller && !controller.signal.aborted;
        setPending(true);
        setMessage('Researching your request…');
        setFailureDetails('');
        setAnswer(undefined);
        setDiscovery([]);
        setIssues([]);
        try {
            const raw = await pluginRequest(api, '/Plugins/LuceSearchAi/Search', controller.signal, { Query: draft.trim() });
            if (!current()) return;
            const result = parseAnswer(raw);
            setAnswer(result);
            if (result.clarification && result.findings.length === 0) {
                setMessage(result.clarification);
                return;
            }
            setMessage('Checking findings in Seerr…');
            try {
                const external = await lookupDiscovery(api, result, controller.signal);
                if (!current()) return;
                setDiscovery(external.cards);
                setIssues(external.issues ?? []);
                setMessage(external.unresolved ?
                    `${external.unresolved} outside-library title(s) could not be verified for a Seerr handoff. Details are listed below.` :
                    'Search complete.');
            } catch (error) {
                if (current()) {
                    setMessage('Library results are ready. Seerr lookup could not complete; no request was submitted.');
                    setFailureDetails(searchFailureDetails(error));
                }
            }
        } catch (error) {
            if (current()) {
                setMessage(searchFailureMessage(error));
                setFailureDetails(searchFailureDetails(error));
            }
        } finally {
            if (current()) {
                request.current = undefined;
                setPending(false);
            }
        }
    }, [ api, researchEnabled, draft ]);

    return (
        <div className='luceAiSearch padded-left padded-right padded-top padded-bottom-page'>
            <button type='button' className='emby-button raised' onClick={onLibrary}>Library search</button>
            <h1>AI search</h1>
            <p className='luceAiSearch-intro'>Describe a movie, show, or episode. Available items open in Jellyfin; other verified findings can be viewed in Seerr.</p>
            <form className='luceAiSearch-form' onSubmit={submit}>
                <label className='inputLabel' htmlFor='luce-ai-search-input'>What are you looking for?</label>
                <input id='luce-ai-search-input' className='emby-input' type='text' maxLength={2000}
                    value={draft} disabled={pending} autoComplete='off'
                    onChange={changeDraft} />
                <div className='luceAiSearch-actions'><button type='submit' className='emby-button raised button-submit'
                    disabled={pending || !researchEnabled || !draft.trim()}>Search with AI</button>
                {pending && <button type='button' className='emby-button' onClick={cancel}>Cancel</button>}
                </div>
            </form>
            {!researchEnabled && <p>AI research is currently disabled by the server administrator.</p>}
            {message && <section className={`luceAiSearch-feedback visualCardBox${failureDetails ? ' luceAiSearch-feedback-error' : ''}`}
                aria-label='AI feedback'>
                <div className='luceAiSearch-feedback-heading'><span className='material-icons' aria-hidden='true'>auto_awesome</span>
                    <span>AI feedback</span></div>
                <p className='luceAiSearch-status' role='status' aria-live='polite'>{message}</p>
                {answer?.clarification && answer.findings.length > 0 && <p>{answer.clarification}</p>}
                {answer?.researchLimited && <p role='status'>Web research reached its search limit. These results use completed searches only; the list or ranking may be incomplete.</p>}
                {failureDetails && <details className='luceAiSearch-details'>
                    <summary>Technical details</summary>
                    <pre>{failureDetails}</pre>
                </details>}
            </section>}
            {answer && (!answer.clarification || answer.findings.length > 0) && (
                <section className='luceAiSearch-section luceAiSearch-library' aria-labelledby='luce-ai-library-heading'>
                    <h2 id='luce-ai-library-heading' className='sectionTitle'>Found in Library</h2>
                    {answer.items.length === 0 && <p className='luceAiSearch-muted'>No library matches found.</p>}
                    {(['Movie', 'Series', 'Episode'] as const).map(kind => {
                        const items = answer.items.filter(item => item.Type === kind);
                        return items.length > 0 ? <SearchResultsRow key={kind}
                            title={rowTitles[kind]} headingLevel={3} items={items} cardOptions={cardOptions} /> : null;
                    })}
                    {answer.resolutions.some(r => ['ambiguous', 'insufficient_evidence'].includes(r.status))
                        && <p>Some findings need a more specific title, year, or episode description.</p>}
                </section>
            )}
            {discovery.length > 0 && (
                <section className='luceAiSearch-section' aria-labelledby='luce-ai-seerr-heading'>
                    <h2 id='luce-ai-seerr-heading' className='sectionTitle'>Discover in Seerr</h2>
                    <p className='luceAiSearch-muted'>View availability and request options in Seerr.</p>
                    <div className='luceAiSearch-discoveries'>
                        {discovery.map(item => (
                            <article key={`${item.kind}:${item.id}`} className='luceAiSearch-discovery'>
                                <a className='luceAiSearch-poster visualCardBox' href={item.url} target='_blank' rel='noopener noreferrer'
                                    aria-label={`View ${item.title} in Seerr`}>
                                    {item.posterPath ? <img alt='' loading='lazy'
                                        src={`https://image.tmdb.org/t/p/w300${item.posterPath}`} /> :
                                        <span className='material-icons' aria-hidden='true'>movie</span>}
                                </a>
                                <h3><a href={item.url} target='_blank' rel='noopener noreferrer'>{item.title}</a></h3>
                                <p className='luceAiSearch-year'>{item.year}</p>
                                <p className='luceAiSearch-evidence'>{evidenceLabels[item.matchEvidence ?? 'title']}</p>
                                {item.seasons.length > 0 && <p className='luceAiSearch-muted'>Relevant seasons: {item.seasons.join(', ')}</p>}
                                <a className='emby-button raised luceAiSearch-request' href={item.url} target='_blank' rel='noopener noreferrer'>View in Seerr / Request</a>
                            </article>
                        ))}
                    </div>
                </section>
            )}
            {issues.length > 0 && <section className='luceAiSearch-section' aria-label='Unresolved discoveries'>
                <h2 className='sectionTitle'>Could not verify in Seerr</h2>
                <ul>{issues.map(item => <li key={`${item.kind}:${item.title}:${item.year}`}>
                    <strong>{item.title}{item.year != null && ` (${item.year})`}</strong>: {item.reason}
                    {item.details && <details className='luceAiSearch-details'><summary>Technical details</summary>
                        <pre>{item.details}</pre>
                    </details>}
                </li>)}</ul>
            </section>}
        </div>
    );
};
export default AiSearch;
