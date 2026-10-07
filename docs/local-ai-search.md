# Local conversational AI search

This is a local Web customization, not an upstream feature. The client targets
Jellyfin Web/Server **10.11.11**, the separately installed **Luce AI Search 1.1.11.0**
plugin (availability contract 2), **Jellyfin Enhanced 12.11.0.0**, and **KefinTweaks
v0.4.13**. The companion plugin is not included in this Web repository. Other
integration versions require revalidation.

## Behavior

Library/Request search remains the default. Allowed signed-in users can switch to
AI mode and explicitly submit a longer movie, show, or episode request. Typing,
navigation restoration, and ordinary debounce never start research. Duplicate
submissions are blocked; cancellation, leaving the view, and account/server changes
discard stale responses. Drafts/results are transient, with no saved-search interface.

Themed AI feedback shows progress, explanations, specific errors, and expandable
Technical details. Found in Library and Discover in Seerr use H2 headings, with
Movies/TV Shows/Episodes as H3 library subsections. Library cards use Jellyfin's
native renderer and real user-accessible DTOs. Discovery cards have rounded posters,
confirmed catalogue titles, identity-evidence labels, and Seerr detail links. The
client never submits a media request automatically.

AI search is global only; scoped research needs a companion-plugin scope contract.
The server owns model selection, research limits, source validation, permissions,
and library matching. The browser receives no provider credential.

## Implementation and hooks

- [Search route](../src/apps/stable/routes/search.tsx): signed-in SDK context and
  read-only plugin availability before exposing AI mode.
- [AiSearch](../src/apps/stable/features/search/components/AiSearch.tsx): request
  lifecycle, feedback, diagnostics, native rows, and discovery cards.
- [aiSearch](../src/apps/stable/features/search/aiSearch.ts): response/DTO validation,
  safe links, and credential-redacted diagnostic formatting.
- [aiSearchClient](../src/apps/stable/features/search/aiSearchClient.ts): authenticated
  plugin requests and bounded GET-only Seerr catalogue/detail reads.
- [aisearch.scss](../src/apps/stable/features/search/components/aisearch.scss): scoped
  AI layout, theme surfaces/buttons, and responsive discovery cards.
- [SearchResultsRow](../src/apps/stable/features/search/components/SearchResultsRow.tsx):
  optional heading level; ordinary search retains H2 by default.

The ordinary `#searchPage` stays mounted but hidden in AI mode. Its separate sibling
`#luceAiSearchPage` owns `#luce-ai-search-input`, isolating Enhanced/Kefin search
listeners and Request filtering from the AI draft/cards. Required versions/hooks
are checked before activation. Fixed section titles go to the native row; model/query
text renders as escaped React text. Third-party installed files are not edited.

Endpoints: `GET /Plugins/LuceSearchAi/Availability`, explicit
`POST /Plugins/LuceSearchAi/Search`, and Enhanced's authenticated
`/JellyfinEnhanced/jellyseerr` GET proxy for account status, search, and details.

## Discovery identity checks

Complete catalogue pages are inspected in relevance order within the server's
1–10-page fallback policy (default five, 20 results/page). A first-page match is
not omitted because later pages exceed the bound. Duplicate/inconsistent pages and
known ambiguity stop selection; uniqueness across unread pages is not claimed.
At most eight outside-library titles are processed, with one detail read/title.

Without provider IDs, selection requires exact title/year/type apart from case and
outer whitespace. A supplied TMDB ID must select the same type/year. An IMDb-only
variant can nominate one same-type/year candidate for a detail read; it becomes a
card only when the detail confirms the expected IMDb ID. All supplied IDs, returned
detail ID, type, and year must agree. Conflicting IDs do not fall back to a title.
Hidden-content filtering and account/session checks apply. Ambiguous variants stay
unresolved, and a failed detail check stops without arbitrary extra reads. Cards
show the confirmed title and distinguish ID evidence from exact title/year/type
evidence without invented confidence percentages.

Episode handoffs use the parent TV title and relevant seasons, including zero.
Links use `/movie/{id}` or `/tv/{id}` and only the verified integration base/identity.
No Seerr request POST or automatic retry is made. Catalogue GETs time out at 15
seconds; Search allows 210 seconds for the supported server deadline plus matching.
Cancelling display does not prove already-started research is free.

## Validation, maintenance, and rollback

Verified desktop behavior includes normal Library/Request transitions, native item
navigation, movie Seerr navigation, mixed results, first-page matches, and the final
themed layout. A live signed-in known-IMDb fixture verifies a title variant in four
GETs with no AI call. Current checks: 257 Web tests (including 42 search), TypeScript,
targeted ESLint/SCSS
lint, and production build.

Live AI grounding of optional IDs, genuine restricted-library scenarios, TV/season
handoff, ranking/coverage, detailed failure snapshots, mobile, and embedded-client
acceptance remain unvalidated. Identity checks do not prove recommendation relevance.

Run the search Vitest suite, `npx tsc --noEmit`, targeted ESLint/SCSS lint, and
`npm run build:production`. Fixtures make no live research calls. Recheck versions,
hooks, account isolation, ordinary search, cards, and served assets after upgrades.

Plugin settings can disable research, matching, or individual accounts. Failed
availability/version/hook checks leave AI controls unavailable and retain ordinary
search. Restoring the preceding complete Web build removes this client integration;
coordinate companion-plugin compatibility and preserve configuration. Host-specific
service/credential/deployment procedures belong in the private operator documents.
Git carries the iteration history.
