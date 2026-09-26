import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import globalize from '../lib/globalize';
import serverNotifications from '../scripts/serverNotifications';
import { toApi } from '../utils/jellyfin-apiclient/compat.ts';
import Events from '../utils/events.ts';

import toast from './toast/toast';

const scanCompletionTimeoutMs = 12 * 60 * 60 * 1000;
const scanPollIntervalMs = 2 * 1000;
const scanNoProgressGraceMs = 8 * 1000;
const scanNoProgressTimeoutMs = 2 * 60 * 1000;
const scanIdleConfirmations = 2;
const supportedLibraryTypes = new Set([ 'homevideos', 'movies', 'musicvideos', 'tvshows' ]);
const pendingScans = new Map();
let isListeningForProgress = false;

function getServerId(apiClient) {
    return apiClient.serverInfo?.().Id || apiClient.serverId?.();
}

function getScanKey(apiClient, itemId) {
    return `${getServerId(apiClient)}:${itemId}`;
}

function stopListeningIfIdle() {
    if (isListeningForProgress && pendingScans.size === 0) {
        Events.off(serverNotifications, 'RefreshProgress', onRefreshProgress);
        isListeningForProgress = false;
    }
}

function removePendingScan(key) {
    const pendingScan = pendingScans.get(key);
    if (pendingScan) {
        clearTimeout(pendingScan.pollTimeout);
        clearTimeout(pendingScan.noProgressTimeout);
        clearTimeout(pendingScan.timeout);
        pendingScans.delete(key);
    }

    stopListeningIfIdle();
}

function onRefreshProgress(_event, apiClient, info) {
    if (!info?.ItemId) {
        return;
    }

    const key = getScanKey(apiClient, info.ItemId);
    const pendingScan = pendingScans.get(key);
    const progress = Number.parseFloat(info.Progress);
    if (!Number.isFinite(progress)) {
        return;
    }

    if (pendingScan && progress > 0 && progress < 100) {
        pendingScan.sawProgress = true;
        pendingScan.idleChecks = 0;
        return;
    }

    if (progress < 100) {
        return;
    }

    if (pendingScan?.acknowledged) {
        removePendingScan(key);
        toast(globalize.translate('ScanComplete'));
    } else if (pendingScan) {
        pendingScan.completed = true;
    }
}

function scheduleCompletionPoll(apiClient, itemId, key) {
    const pendingScan = pendingScans.get(key);
    if (!pendingScan || pendingScan.pollTimeout) {
        return;
    }

    pendingScan.pollTimeout = setTimeout(async () => {
        const currentScan = pendingScans.get(key);
        if (!currentScan) {
            return;
        }

        currentScan.pollTimeout = null;
        try {
            const refreshedItem = await apiClient.getItem(apiClient.getCurrentUserId(), itemId);
            if (pendingScans.get(key) !== currentScan) {
                return;
            }

            const progress = Number.parseFloat(refreshedItem.RefreshProgress);
            const status = refreshedItem.RefreshStatus;
            const isActive = status ? status !== 'Idle' : progress > 0 && progress < 100;

            if (isActive) {
                currentScan.sawProgress = true;
                currentScan.idleChecks = 0;
            } else if (currentScan.sawProgress || currentScan.allowIdleCompletion && Date.now() - currentScan.startedAt >= scanNoProgressGraceMs) {
                currentScan.idleChecks++;
                if (currentScan.sawProgress || currentScan.idleChecks >= scanIdleConfirmations) {
                    Events.trigger(serverNotifications, 'RefreshProgress', [
                        apiClient,
                        { ItemId: itemId, Progress: 100 }
                    ]);
                    return;
                }
            }
        } catch {
            // A transient status lookup must not turn an accepted scan into a failure.
        }

        if (pendingScans.get(key) === currentScan) {
            scheduleCompletionPoll(apiClient, itemId, key);
        }
    }, scanPollIntervalMs);
}

function trackScanCompletion(apiClient, itemId, allowIdleCompletion) {
    const key = getScanKey(apiClient, itemId);
    removePendingScan(key);

    if (!isListeningForProgress) {
        Events.on(serverNotifications, 'RefreshProgress', onRefreshProgress);
        isListeningForProgress = true;
    }

    pendingScans.set(key, {
        acknowledged: false,
        allowIdleCompletion,
        completed: false,
        idleChecks: 0,
        noProgressTimeout: allowIdleCompletion ? null : setTimeout(() => {
            const pendingScan = pendingScans.get(key);
            if (pendingScan && !pendingScan.sawProgress) {
                removePendingScan(key);
            }
        }, scanNoProgressTimeoutMs),
        pollTimeout: null,
        sawProgress: false,
        startedAt: Date.now(),
        timeout: setTimeout(() => removePendingScan(key), scanCompletionTimeoutMs)
    });
    return key;
}

function normalizeItemId(itemId) {
    return itemId?.replaceAll('-', '').toLowerCase();
}

async function reportLibraryPathsChanged(apiClient, item) {
    // Jellyfin 10.11's item-refresh endpoint only queues metadata for the
    // virtual collection folder. Report its physical roots to LibraryMonitor
    // so the server actually enumerates new and changed files.
    const virtualFolders = await apiClient.getVirtualFolders();
    const itemId = normalizeItemId(item.Id);
    const virtualFolder = virtualFolders.find(folder => normalizeItemId(folder.ItemId) === itemId);
    const locations = virtualFolder?.Locations?.filter(Boolean) || [];

    if (!locations.length) {
        throw new Error(`No configured media paths found for library ${item.Id}`);
    }

    return getLibraryApi(toApi(apiClient)).postUpdatedMedia({
        mediaUpdateInfoDto: {
            Updates: locations.map(Path => ({
                Path,
                UpdateType: 'Modified'
            }))
        }
    });
}

export function canScanFiles(item, user) {
    if (!user?.Policy?.IsAdministrator || !item || item.IsPlaceHolder) {
        return false;
    }

    if (item.Type === 'CollectionFolder') {
        return supportedLibraryTypes.has(item.CollectionType);
    }

    return (item.Type === 'Series' || item.Type === 'Season')
        && item.LocationType !== 'Virtual';
}

export function getScanFilesLabel(item) {
    return item.Type === 'CollectionFolder' ? 'ScanLibraryFiles' : 'ScanForNewAndUpdatedFiles';
}

export async function scanFiles(apiClient, item) {
    const isLibrary = item.Type === 'CollectionFolder';
    // A path-triggered library refresh is not guaranteed to publish progress
    // against the virtual folder id, so idle alone must not imply completion.
    const scanKey = trackScanCompletion(apiClient, item.Id, !isLibrary);

    try {
        if (isLibrary) {
            await reportLibraryPathsChanged(apiClient, item);
        } else {
            await apiClient.refreshItem(item.Id, {
                ImageRefreshMode: 'Default',
                MetadataRefreshMode: 'Default'
            });
        }

        const pendingScan = pendingScans.get(scanKey);
        if (pendingScan) {
            pendingScan.acknowledged = true;
        }

        toast(globalize.translate('ScanStarted'));

        if (pendingScan?.completed) {
            removePendingScan(scanKey);
            toast(globalize.translate('ScanComplete'));
        } else {
            scheduleCompletionPoll(apiClient, item.Id, scanKey);
        }
    } catch (error) {
        removePendingScan(scanKey);
        toast(globalize.translate('ScanFailed'));
        throw error;
    }
}
