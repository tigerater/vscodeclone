/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { Event } from 'vs/base/common/event';
import { IExtensionIdentifier, EXTENSION_IDENTIFIER_PATTERN } from 'vs/platform/extensionManagement/common/extensionManagement';
import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope, allSettings } from 'vs/platform/configuration/common/configurationRegistry';
import { localize } from 'vs/nls';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IJSONContributionRegistry, Extensions as JSONExtensions } from 'vs/platform/jsonschemas/common/jsonContributionRegistry';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { ILogService } from 'vs/platform/log/common/log';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IStringDictionary } from 'vs/base/common/collections';
import { FormattingOptions } from 'vs/base/common/jsonFormatter';
import { URI } from 'vs/base/common/uri';
import { isEqual, joinPath } from 'vs/base/common/resources';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

export const CONFIGURATION_SYNC_STORE_KEY = 'configurationSync.store';

export interface ISyncConfiguration {
	sync: {
		enable: boolean,
		enableSettings: boolean,
		enableKeybindings: boolean,
		enableUIState: boolean,
		enableExtensions: boolean,
		keybindingsPerPlatform: boolean,
		ignoredExtensions: string[],
		ignoredSettings: string[]
	}
}

export function getDefaultIgnoredSettings(): string[] {
	const allSettings = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
	const machineSettings = Object.keys(allSettings).filter(setting => allSettings[setting].scope === ConfigurationScope.MACHINE || allSettings[setting].scope === ConfigurationScope.MACHINE_OVERRIDABLE);
	return [CONFIGURATION_SYNC_STORE_KEY, ...machineSettings];
}

export function registerConfiguration(): IDisposable {
	const ignoredSettingsSchemaId = 'vscode://schemas/ignoredSettings';
	const ignoredExtensionsSchemaId = 'vscode://schemas/ignoredExtensions';
	const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	configurationRegistry.registerConfiguration({
		id: 'sync',
		order: 30,
		title: localize('sync', "Sync"),
		type: 'object',
		properties: {
			'sync.enable': {
				type: 'boolean',
				default: false,
				scope: ConfigurationScope.APPLICATION,
				deprecationMessage: 'deprecated'
			},
			'sync.enableSettings': {
				type: 'boolean',
				default: true,
				scope: ConfigurationScope.APPLICATION,
				deprecationMessage: 'deprecated'
			},
			'sync.enableKeybindings': {
				type: 'boolean',
				default: true,
				scope: ConfigurationScope.APPLICATION,
				deprecationMessage: 'Deprecated'
			},
			'sync.enableUIState': {
				type: 'boolean',
				default: true,
				scope: ConfigurationScope.APPLICATION,
				deprecationMessage: 'deprecated'
			},
			'sync.enableExtensions': {
				type: 'boolean',
				default: true,
				scope: ConfigurationScope.APPLICATION,
				deprecationMessage: 'deprecated'
			},
			'sync.keybindingsPerPlatform': {
				type: 'boolean',
				description: localize('sync.keybindingsPerPlatform', "Synchronize keybindings per platform."),
				default: true,
				scope: ConfigurationScope.APPLICATION,
			},
			'sync.ignoredExtensions': {
				'type': 'array',
				'description': localize('sync.ignoredExtensions', "List of extensions to be ignored while synchronizing. The identifier of an extension is always ${publisher}.${name}. For example: vscode.csharp."),
				$ref: ignoredExtensionsSchemaId,
				'default': [],
				'scope': ConfigurationScope.APPLICATION,
				uniqueItems: true,
				disallowSyncIgnore: true
			},
			'sync.ignoredSettings': {
				'type': 'array',
				description: localize('sync.ignoredSettings', "Configure settings to be ignored while synchronizing."),
				'default': [],
				'scope': ConfigurationScope.APPLICATION,
				$ref: ignoredSettingsSchemaId,
				additionalProperties: true,
				uniqueItems: true,
				disallowSyncIgnore: true
			}
		}
	});
	const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
	const registerIgnoredSettingsSchema = () => {
		const defaultIgnoreSettings = getDefaultIgnoredSettings().filter(s => s !== CONFIGURATION_SYNC_STORE_KEY);
		const ignoredSettingsSchema: IJSONSchema = {
			items: {
				type: 'string',
				enum: [...Object.keys(allSettings.properties).filter(setting => defaultIgnoreSettings.indexOf(setting) === -1), ...defaultIgnoreSettings.map(setting => `-${setting}`)]
			},
		};
		jsonRegistry.registerSchema(ignoredSettingsSchemaId, ignoredSettingsSchema);
	};
	jsonRegistry.registerSchema(ignoredExtensionsSchemaId, {
		type: 'string',
		pattern: EXTENSION_IDENTIFIER_PATTERN,
		errorMessage: localize('app.extension.identifier.errorMessage', "Expected format '${publisher}.${name}'. Example: 'vscode.csharp'.")
	});
	return configurationRegistry.onDidUpdateConfiguration(() => registerIgnoredSettingsSchema());
}

// #region User Data Sync Store

export interface IUserData {
	ref: string;
	content: string | null;
}

export interface IUserDataSyncStore {
	url: URI;
	authenticationProviderId: string;
}

export function getUserDataSyncStore(configurationService: IConfigurationService): IUserDataSyncStore | undefined {
	const value = configurationService.getValue<{ url: string, authenticationProviderId: string }>(CONFIGURATION_SYNC_STORE_KEY);
	if (value && value.url && value.authenticationProviderId) {
		return {
			url: joinPath(URI.parse(value.url), 'v1'),
			authenticationProviderId: value.authenticationProviderId
		};
	}
	return undefined;
}

export const ALL_RESOURCE_KEYS: ResourceKey[] = ['settings', 'keybindings', 'extensions', 'globalState'];
export type ResourceKey = 'settings' | 'keybindings' | 'extensions' | 'globalState';

export interface IUserDataManifest {
	latest?: Record<ResourceKey, string>
	session: string;
}

export const IUserDataSyncStoreService = createDecorator<IUserDataSyncStoreService>('IUserDataSyncStoreService');
export interface IUserDataSyncStoreService {
	_serviceBrand: undefined;
	readonly userDataSyncStore: IUserDataSyncStore | undefined;
	read(key: ResourceKey, oldValue: IUserData | null, source?: SyncSource): Promise<IUserData>;
	write(key: ResourceKey, content: string, ref: string | null, source?: SyncSource): Promise<string>;
	manifest(): Promise<IUserDataManifest | null>;
	clear(): Promise<void>;
}

//#endregion

// #region User Data Sync Error

export enum UserDataSyncErrorCode {
	// Server Errors
	Unauthorized = 'Unauthorized',
	Forbidden = 'Forbidden',
	ConnectionRefused = 'ConnectionRefused',
	RemotePreconditionFailed = 'RemotePreconditionFailed',
	TooLarge = 'TooLarge',
	NoRef = 'NoRef',
	TurnedOff = 'TurnedOff',
	SessionExpired = 'SessionExpired',

	// Local Errors
	LocalPreconditionFailed = 'LocalPreconditionFailed',
	LocalInvalidContent = 'LocalInvalidContent',
	LocalError = 'LocalError',
	Incompatible = 'Incompatible',

	Unknown = 'Unknown',
}

export class UserDataSyncError extends Error {

	constructor(message: string, public readonly code: UserDataSyncErrorCode, public readonly source?: SyncSource) {
		super(message);
		this.name = `${this.code} (UserDataSyncError) ${this.source}`;
	}

	static toUserDataSyncError(error: Error): UserDataSyncError {
		if (error instanceof UserDataSyncStoreError) {
			return error;
		}
		const match = /^(.+) \(UserDataSyncError\) (.+)?$/.exec(error.name);
		if (match && match[1]) {
			return new UserDataSyncError(error.message, <UserDataSyncErrorCode>match[1], <SyncSource>match[2]);
		}
		return new UserDataSyncError(error.message, UserDataSyncErrorCode.Unknown);
	}

}

export class UserDataSyncStoreError extends UserDataSyncError { }

//#endregion

// #region User Data Synchroniser

export interface ISyncExtension {
	identifier: IExtensionIdentifier;
	version?: string;
	disabled?: boolean;
}

export interface IGlobalState {
	argv: IStringDictionary<any>;
	storage: IStringDictionary<any>;
}

export const enum SyncSource {
	Settings = 'Settings',
	Keybindings = 'Keybindings',
	Extensions = 'Extensions',
	GlobalState = 'GlobalState'
}

export const enum SyncStatus {
	Uninitialized = 'uninitialized',
	Idle = 'idle',
	Syncing = 'syncing',
	HasConflicts = 'hasConflicts',
}

export interface IUserDataSynchroniser {

	readonly resourceKey: ResourceKey;
	readonly source: SyncSource;
	readonly status: SyncStatus;
	readonly onDidChangeStatus: Event<SyncStatus>;
	readonly onDidChangeLocal: Event<void>;

	pull(): Promise<void>;
	push(): Promise<void>;
	sync(ref?: string): Promise<void>;
	stop(): Promise<void>;

	hasPreviouslySynced(): Promise<boolean>
	hasLocalData(): Promise<boolean>;
	resetLocal(): Promise<void>;

	getRemoteContent(preivew?: boolean): Promise<string | null>;
	accept(content: string): Promise<void>;
}

//#endregion

// #region User Data Sync Services

export const IUserDataSyncEnablementService = createDecorator<IUserDataSyncEnablementService>('IUserDataSyncEnablementService');
export interface IUserDataSyncEnablementService {
	_serviceBrand: any;

	readonly onDidChangeEnablement: Event<boolean>;
	readonly onDidChangeResourceEnablement: Event<[ResourceKey, boolean]>;

	isEnabled(): boolean;
	setEnablement(enabled: boolean): void;

	isResourceEnabled(key: ResourceKey): boolean;
	setResourceEnablement(key: ResourceKey, enabled: boolean): void;
}

export const IUserDataSyncService = createDecorator<IUserDataSyncService>('IUserDataSyncService');
export interface IUserDataSyncService {
	_serviceBrand: any;

	readonly status: SyncStatus;
	readonly onDidChangeStatus: Event<SyncStatus>;

	readonly conflictsSources: SyncSource[];
	readonly onDidChangeConflicts: Event<SyncSource[]>;

	readonly onDidChangeLocal: Event<void>;
	readonly onSyncErrors: Event<[SyncSource, UserDataSyncError][]>;

	readonly lastSyncTime: number | undefined;
	readonly onDidChangeLastSyncTime: Event<number>;

	pull(): Promise<void>;
	sync(): Promise<void>;
	stop(): Promise<void>;
	reset(): Promise<void>;
	resetLocal(): Promise<void>;

	isFirstTimeSyncWithMerge(): Promise<boolean>;
	getRemoteContent(source: SyncSource, preview: boolean): Promise<string | null>;
	accept(source: SyncSource, content: string): Promise<void>;
}

export const IUserDataAutoSyncService = createDecorator<IUserDataAutoSyncService>('IUserDataAutoSyncService');
export interface IUserDataAutoSyncService {
	_serviceBrand: any;
	readonly onError: Event<UserDataSyncError>;
	triggerAutoSync(): Promise<void>;
}

export const IUserDataSyncUtilService = createDecorator<IUserDataSyncUtilService>('IUserDataSyncUtilService');
export interface IUserDataSyncUtilService {
	_serviceBrand: undefined;
	resolveUserBindings(userbindings: string[]): Promise<IStringDictionary<string>>;
	resolveFormattingOptions(resource: URI): Promise<FormattingOptions>;
	resolveDefaultIgnoredSettings(): Promise<string[]>;
}

export const IUserDataSyncLogService = createDecorator<IUserDataSyncLogService>('IUserDataSyncLogService');
export interface IUserDataSyncLogService extends ILogService { }

export interface IConflictSetting {
	key: string;
	localValue: any | undefined;
	remoteValue: any | undefined;
}

export const ISettingsSyncService = createDecorator<ISettingsSyncService>('ISettingsSyncService');
export interface ISettingsSyncService extends IUserDataSynchroniser {
	_serviceBrand: any;
	readonly onDidChangeConflicts: Event<IConflictSetting[]>;
	readonly conflicts: IConflictSetting[];
	resolveSettingsConflicts(resolvedConflicts: { key: string, value: any | undefined }[]): Promise<void>;
}

//#endregion

export const CONTEXT_SYNC_STATE = new RawContextKey<string>('syncStatus', SyncStatus.Uninitialized);
export const CONTEXT_SYNC_ENABLEMENT = new RawContextKey<boolean>('syncEnabled', false);

export const USER_DATA_SYNC_SCHEME = 'vscode-userdata-sync';
export function toRemoteContentResource(source: SyncSource): URI {
	return URI.from({ scheme: USER_DATA_SYNC_SCHEME, path: `${source}/remoteContent` });
}
export function getSyncSourceFromRemoteContentResource(uri: URI): SyncSource | undefined {
	return [SyncSource.Settings, SyncSource.Keybindings, SyncSource.Extensions, SyncSource.GlobalState].filter(source => isEqual(uri, toRemoteContentResource(source)))[0];
}
export function getSyncSourceFromPreviewResource(uri: URI, environmentService: IEnvironmentService): SyncSource | undefined {
	if (isEqual(uri, environmentService.settingsSyncPreviewResource)) {
		return SyncSource.Settings;
	}
	if (isEqual(uri, environmentService.keybindingsSyncPreviewResource)) {
		return SyncSource.Keybindings;
	}
	return undefined;
}
