import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api } from '@jellyfin/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AiSearch from './AiSearch';
import { lookupDiscovery, pluginRequest } from '../aiSearchClient';

vi.mock('../aiSearchClient', () => ({ pluginRequest: vi.fn(), lookupDiscovery: vi.fn(), compatibleSearchHooks: () => true }));
vi.mock('../../../../../utils/card', () => ({ CardShape: { AutoOverflow: 'autooverflow' } }));
vi.mock('./SearchResultsRow', () => ({ default: ({ title, headingLevel = 2 }: { title: string; headingLevel?: number }) =>
    React.createElement(`h${headingLevel}`, {}, title) }));

const id = 'a'.repeat(32);
const answer = { Research: { Findings: [{ Kind: 'Episode', Title: 'The Simpsons', Year: 1989, SourceIndices: [0] }],
    Resolutions: [{ CandidateIndex: 0, Status: 'matched', ItemIds: [id] }], ListComplete: false },
Items: [{ Id: id, Type: 'Episode' }] };
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    vi.resetAllMocks();
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    element = document.createElement('div');
    document.body.appendChild(element);
    root = createRoot(element);
});
afterEach(async () => {
    await act(async () => root.unmount());
    element.remove();
});
async function render(researchEnabled = true) {
    await act(async () => root.render(<AiSearch api={{} as Api} researchEnabled={researchEnabled} onLibrary={vi.fn()} />));
    const input = element.querySelector('input') as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Halloween episodes');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
function submit() {
    element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
it('typing makes no request; one explicit submission uses the plugin once', async () => {
    vi.mocked(pluginRequest).mockResolvedValue(answer);
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [], unresolved: 0 });
    await render();
    expect(pluginRequest).not.toHaveBeenCalled();
    await act(async () => submit());
    expect(pluginRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pluginRequest).mock.calls[0][1]).toBe('/Plugins/LuceSearchAi/Search');
    expect(element.querySelector('#luce-ai-library-heading')?.textContent).toBe('Found in Library');
    expect(element.textContent).toContain('Episodes');
});
it('research disabled blocks submission even from a synthetic form event', async () => {
    await render(false);
    await act(async () => submit());
    expect(pluginRequest).not.toHaveBeenCalled();
});
it('renders expandable failure diagnostics and source URLs without headers or credentials', async () => {
    vi.mocked(pluginRequest).mockRejectedValue({ response: { status: 502, headers: { Authorization: 'secret-header' },
        data: { Code: 'unverified_sources', Diagnostics: { ResponseStatus: 'completed', SearchStatuses: { completed: 2 },
            MaxToolCalls: 4, OutputTokens: 1152, ValidationStage: 'source_provenance',
            // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Synthetic credential-redaction fixture.
            ValidationFailure: { Reason: 'Invalid source index', Input: { Title: 'Dark City', SourceIndices: [1], password: 'secret-password' } },
            FutureDiagnostic: { count: 7 },
            SourceComparison: { ClaimedUrls: ['https://example.com/cited'], ObservedUrls: ['https://example.com/observed?token=secret-url'], Truncated: false } } } } });
    await render();
    await act(async () => submit());
    expect(element.querySelector('summary')?.textContent).toBe('Technical details');
    expect(element.querySelector('pre')?.textContent).toContain('1152');
    expect(element.querySelector('pre')?.textContent).toContain('Invalid source index');
    expect(element.querySelector('pre')?.textContent).toContain('Dark City');
    expect(element.querySelector('pre')?.textContent).toContain('FutureDiagnostic');
    expect(element.querySelector('pre')?.textContent).toContain('https://example.com/cited');
    expect(element.querySelector('pre')?.textContent).toContain('https://example.com/observed');
    expect(element.textContent).not.toContain('secret-header');
    expect(element.textContent).not.toContain('secret-url');
    expect(element.textContent).not.toContain('secret-password');
    expect(pluginRequest).toHaveBeenCalledTimes(1);
    vi.mocked(pluginRequest).mockResolvedValue(answer);
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [], unresolved: 0 });
    await act(async () => submit());
    expect(element.querySelector('details')).toBeNull();
});
it('duplicate submissions and cancelled late results cannot produce another request or cards', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(pluginRequest).mockImplementation(() => new Promise(resolve => {
        finish = resolve;
    }));
    await render();
    await act(async () => {
        submit();
        submit();
    });
    expect(pluginRequest).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(pluginRequest).mock.calls[0][2];
    const cancel = [...element.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
    await act(async () => cancel?.click());
    expect(signal.aborted).toBe(true);
    await act(async () => finish(answer));
    expect(element.textContent).not.toContain('1 item(s) found');
    expect(lookupDiscovery).not.toHaveBeenCalled();
});
it('leaving the AI view aborts research and discards late results', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(pluginRequest).mockImplementation(() => new Promise(resolve => {
        finish = resolve;
    }));
    await render();
    await act(async () => submit());
    const signal = vi.mocked(pluginRequest).mock.calls[0][2];
    await act(async () => root.render(<div>Library mode</div>));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(answer));
    expect(lookupDiscovery).not.toHaveBeenCalled();
});
it('keeps library cards when Seerr is unavailable', async () => {
    vi.mocked(pluginRequest).mockResolvedValue(answer);
    vi.mocked(lookupDiscovery).mockRejectedValue(new Error('Offline'));
    await render();
    await act(async () => submit());
    expect(element.querySelector('#luce-ai-library-heading')?.textContent).toBe('Found in Library');
    expect(element.textContent).toContain('Seerr lookup could not complete');
});
it('shows answer context beside verified cards and still performs discovery lookup', async () => {
    const context = 'I interpreted this as movies from 2000–2009 and used audience ratings.';
    vi.mocked(pluginRequest).mockResolvedValue({ ...answer, Research: { ...answer.Research, Clarification: context } });
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [], unresolved: 0 });
    await render();
    await act(async () => submit());
    expect(element.textContent).toContain(context);
    expect(element.querySelector('#luce-ai-library-heading')?.textContent).toBe('Found in Library');
    expect(element.textContent).toContain('Episodes');
    expect(element.textContent).not.toContain('Verified library match');
    expect(element.textContent).not.toContain('not recommendation quality or ranking accuracy');
    expect(element.textContent).not.toContain('Submitting uses external AI research');
    expect(element.textContent).not.toContain('These findings are not verified as an exhaustive list');
    expect(element.querySelector('h3')?.textContent).toBe('Episodes');
    expect(element.querySelector('[aria-label="AI feedback"]')?.textContent).toContain(context);
    expect(lookupDiscovery).toHaveBeenCalledTimes(1);
    expect(pluginRequest).toHaveBeenCalledTimes(1);
});
it('labels catalogue identity evidence without presenting an invented percentage', async () => {
    vi.mocked(pluginRequest).mockResolvedValue(answer);
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [{ title: 'Snatch', year: 2000, kind: 'Movie', id: 107,
        url: 'https://seerr.example/movie/107', seasons: [] }], unresolved: 0 });
    await render();
    await act(async () => submit());
    expect(element.textContent).toContain('Title/year/type matched; Seerr ID confirmed.');
    expect(element.textContent).not.toContain('100%');
});
it('keeps clarification-only responses as questions without cards or discovery requests', async () => {
    vi.mocked(pluginRequest).mockResolvedValue({ Research: { Findings: [], Resolutions: [],
        Clarification: 'Which rating source do you prefer?', ListComplete: false }, Items: [] });
    await render();
    await act(async () => submit());
    expect(element.textContent).toContain('Which rating source do you prefer?');
    expect(element.textContent).not.toContain('item(s) found');
    expect(lookupDiscovery).not.toHaveBeenCalled();
});
it('shows a research-limit notice while retaining verified cards and discovery', async () => {
    vi.mocked(pluginRequest).mockResolvedValue({ ...answer, Research: { ...answer.Research, ResearchLimited: true } });
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [], unresolved: 0 });
    await render();
    await act(async () => submit());
    expect(element.textContent).toContain('Web research reached its search limit');
    expect(element.textContent).toContain('list or ranking may be incomplete');
    expect(element.querySelector('#luce-ai-library-heading')?.textContent).toBe('Found in Library');
    expect(lookupDiscovery).toHaveBeenCalledTimes(1);
    expect(pluginRequest).toHaveBeenCalledTimes(1);
});
it('names an omitted title and its specific catalogue limit without suppressing library cards', async () => {
    vi.mocked(pluginRequest).mockResolvedValue(answer);
    vi.mocked(lookupDiscovery).mockResolvedValue({ cards: [], unresolved: 1,
        issues: [{ kind: 'Movie', title: 'Snatch', year: 2000, reason: 'Seerr returned 8 pages; the configured limit is 5.' }] });
    await render();
    await act(async () => submit());
    expect(element.querySelector('#luce-ai-library-heading')?.textContent).toBe('Found in Library');
    expect(element.textContent).toContain('Snatch (2000)');
    expect(element.textContent).toContain('Seerr returned 8 pages; the configured limit is 5.');
    expect(element.textContent).not.toContain('Refine the title or year');
});
