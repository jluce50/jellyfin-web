import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { UserSettings } from './userSettings';

const appSettings = vi.hoisted(() => ({
    get: vi.fn(),
    set: vi.fn()
}));

vi.mock('./appSettings', () => ({
    default: appSettings
}));

const preferenceName = 'enableResumableInNextUp';

function createApiClient(customPrefs = {}) {
    return {
        getDisplayPreferences: vi.fn().mockResolvedValue({ CustomPrefs: { ...customPrefs } }),
        updateDisplayPreferences: vi.fn().mockResolvedValue()
    };
}

describe('enableResumableInNextUp', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        appSettings.get.mockReturnValue(null);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('defaults off when neither the server nor the client has a value', async () => {
        const settings = new UserSettings();
        const apiClient = createApiClient();

        await settings.setUserInfo('user-1', apiClient);

        expect(settings.enableResumableInNextUp()).toBe(false);
        expect(apiClient.updateDisplayPreferences).not.toHaveBeenCalled();
    });

    test('migrates a legacy local opt-in when the server has no value', async () => {
        appSettings.get.mockReturnValue('true');
        const settings = new UserSettings();
        const apiClient = createApiClient();

        await settings.setUserInfo('user-1', apiClient);

        expect(settings.enableResumableInNextUp()).toBe(true);
        expect(apiClient.updateDisplayPreferences).toHaveBeenCalledWith(
            'usersettings',
            { CustomPrefs: { [preferenceName]: 'true' } },
            'user-1',
            'emby'
        );
    });

    test('does not migrate a legacy local false value', async () => {
        appSettings.get.mockReturnValue('false');
        const settings = new UserSettings();
        const apiClient = createApiClient();

        await settings.setUserInfo('user-1', apiClient);

        expect(settings.enableResumableInNextUp()).toBe(false);
        expect(apiClient.updateDisplayPreferences).not.toHaveBeenCalled();
    });

    test.each([
        [ 'true', 'false', true ],
        [ 'false', 'true', false ]
    ])('prefers an established server value of %s over legacy %s', async (serverValue, legacyValue, expected) => {
        appSettings.get.mockReturnValue(legacyValue);
        const settings = new UserSettings();
        const apiClient = createApiClient({ [preferenceName]: serverValue });

        await settings.setUserInfo('user-1', apiClient);

        expect(settings.enableResumableInNextUp()).toBe(expected);
        expect(apiClient.updateDisplayPreferences).not.toHaveBeenCalled();
    });

    test('keeps the legacy opt-in for the session when migration cannot be saved', async () => {
        appSettings.get.mockReturnValue('true');
        const settings = new UserSettings();
        const apiClient = createApiClient();
        apiClient.updateDisplayPreferences.mockRejectedValue(new Error('request failed'));

        await expect(settings.setUserInfo('user-1', apiClient)).resolves.toBeUndefined();

        expect(settings.enableResumableInNextUp()).toBe(true);
    });

    test('preserves the existing display-preference read failure behavior', async () => {
        const settings = new UserSettings();
        const apiClient = createApiClient();
        apiClient.getDisplayPreferences.mockRejectedValue(new Error('request failed'));

        await expect(settings.setUserInfo('user-1', apiClient)).rejects.toThrow('request failed');
    });

    test('keeps server values isolated when the active user changes', async () => {
        const settings = new UserSettings();
        const firstApiClient = createApiClient({ [preferenceName]: 'true' });
        const secondApiClient = createApiClient({ [preferenceName]: 'false' });

        await settings.setUserInfo('user-1', firstApiClient);
        expect(settings.enableResumableInNextUp()).toBe(true);

        await settings.setUserInfo('user-2', secondApiClient);
        expect(settings.enableResumableInNextUp()).toBe(false);
    });

    test.each([
        [ true, 'true' ],
        [ false, 'false' ]
    ])('saves %s to local storage and server display preferences', async (value, serializedValue) => {
        const settings = new UserSettings();
        const apiClient = createApiClient();
        await settings.setUserInfo('user-1', apiClient);

        settings.enableResumableInNextUp(value);
        await vi.advanceTimersByTimeAsync(50);

        expect(appSettings.set).toHaveBeenCalledWith(preferenceName, serializedValue, 'user-1');
        expect(apiClient.updateDisplayPreferences).toHaveBeenCalledWith(
            'usersettings',
            { CustomPrefs: { [preferenceName]: serializedValue } },
            'user-1',
            'emby'
        );
    });
});
