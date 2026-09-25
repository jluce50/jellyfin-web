import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import serverNotifications from '../scripts/serverNotifications';
import Events from '../utils/events.ts';

import toast from './toast/toast';
import { canScanFiles, getScanFilesLabel, scanFiles } from './scanFiles';

vi.mock('../lib/globalize', () => ({
    default: {
        translate: key => key
    }
}));

vi.mock('../scripts/serverNotifications', () => ({
    default: {}
}));

vi.mock('./toast/toast', () => ({
    default: vi.fn()
}));

describe('canScanFiles', () => {
    const admin = { Policy: { IsAdministrator: true } };
    const user = { Policy: { IsAdministrator: false } };

    test.each([
        [ 'CollectionFolder', 'movies' ],
        [ 'CollectionFolder', 'tvshows' ],
        [ 'CollectionFolder', 'musicvideos' ],
        [ 'CollectionFolder', 'homevideos' ],
        [ 'Series', undefined ],
        [ 'Season', undefined ]
    ])('allows an administrator to scan %s', (Type, CollectionType) => {
        expect(canScanFiles({ Type, CollectionType }, admin)).toBe(true);
    });

    test.each([
        { Type: 'Movie' },
        { Type: 'MusicVideo' },
        { Type: 'Episode' },
        { Type: 'CollectionFolder', CollectionType: 'books' },
        { Type: 'CollectionFolder', CollectionType: 'music' },
        { Type: 'CollectionFolder', CollectionType: 'photos' },
        { Type: 'CollectionFolder', CollectionType: 'mixed' },
        { Type: 'CollectionFolder', CollectionType: 'livetv' },
        { Type: 'Series', LocationType: 'Virtual' },
        { Type: 'Season', LocationType: 'Virtual' },
        { Type: 'Season', IsPlaceHolder: true }
    ])('does not offer unsupported scope %#', item => {
        expect(canScanFiles(item, admin)).toBe(false);
    });

    test('does not offer scans to a non-administrator', () => {
        expect(canScanFiles({ Type: 'CollectionFolder', CollectionType: 'movies' }, user)).toBe(false);
        expect(canScanFiles({ Type: 'Series' }, user)).toBe(false);
    });
});

test('uses a library-specific label', () => {
    expect(getScanFilesLabel({ Type: 'CollectionFolder' })).toBe('ScanLibraryFiles');
    expect(getScanFilesLabel({ Type: 'Series' })).toBe('ScanForNewAndUpdatedFiles');
});

describe('scanFiles', () => {
    let apiClient;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        apiClient = {
            getCurrentUserId: vi.fn().mockReturnValue('user-1'),
            getItem: vi.fn().mockResolvedValue({ RefreshStatus: 'Idle' }),
            refreshItem: vi.fn().mockResolvedValue(),
            serverInfo: () => ({ Id: 'server-1' })
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('starts a default-mode scan and reports completion', async () => {
        await scanFiles(apiClient, { Id: 'library-1' });

        expect(apiClient.refreshItem).toHaveBeenCalledWith('library-1', {
            ImageRefreshMode: 'Default',
            MetadataRefreshMode: 'Default'
        });
        expect(toast).toHaveBeenCalledWith('ScanStarted');

        Events.trigger(serverNotifications, 'RefreshProgress', [
            apiClient,
            { ItemId: 'library-1', Progress: '100' }
        ]);

        expect(toast).toHaveBeenLastCalledWith('ScanComplete');
    });

    test('reports a request failure', async () => {
        apiClient.refreshItem.mockRejectedValue(new Error('request failed'));

        await expect(scanFiles(apiClient, { Id: 'series-1' })).rejects.toThrow('request failed');
        expect(toast).toHaveBeenCalledWith('ScanFailed');
    });

    test('falls back to polling until an active scan returns to idle', async () => {
        apiClient.getItem
            .mockResolvedValueOnce({ RefreshStatus: 'Running', RefreshProgress: 63 })
            .mockResolvedValueOnce({ RefreshStatus: 'Idle', RefreshProgress: 63 });

        await scanFiles(apiClient, { Id: 'library-2' });
        await vi.advanceTimersByTimeAsync(2_000);

        expect(toast).not.toHaveBeenCalledWith('ScanComplete');

        await vi.advanceTimersByTimeAsync(2_000);

        expect(apiClient.getItem).toHaveBeenCalledWith('user-1', 'library-2');
        expect(toast).toHaveBeenLastCalledWith('ScanComplete');
    });

    test('confirms consecutive idle results for a fast scan with no progress events', async () => {
        await scanFiles(apiClient, { Id: 'library-3' });
        await vi.advanceTimersByTimeAsync(8_000);

        expect(toast).not.toHaveBeenCalledWith('ScanComplete');

        await vi.advanceTimersByTimeAsync(2_000);

        expect(toast).toHaveBeenLastCalledWith('ScanComplete');
    });

    test('keeps notifications ordered when completion arrives before the request acknowledgement', async () => {
        let acknowledgeRequest;
        apiClient.refreshItem.mockReturnValue(new Promise(resolve => {
            acknowledgeRequest = resolve;
        }));

        const scanPromise = scanFiles(apiClient, { Id: 'season-1' });
        Events.trigger(serverNotifications, 'RefreshProgress', [
            apiClient,
            { ItemId: 'season-1', Progress: '100' }
        ]);
        acknowledgeRequest();
        await scanPromise;

        expect(toast.mock.calls).toEqual([
            [ 'ScanStarted' ],
            [ 'ScanComplete' ]
        ]);
    });
});
