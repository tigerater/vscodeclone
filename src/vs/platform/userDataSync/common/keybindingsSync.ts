/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService, FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { UserDataSyncError, UserDataSyncErrorCode, SyncStatus, IUserDataSyncStoreService, IUserDataSyncLogService, IUserDataSyncUtilService, SyncSource, IUserDataSynchroniser, IUserDataSyncEnablementService, IUserDataSyncBackupStoreService } from 'vs/platform/userDataSync/common/userDataSync';
import { merge } from 'vs/platform/userDataSync/common/keybindingsMerge';
import { VSBuffer } from 'vs/base/common/buffer';
import { parse } from 'vs/base/common/json';
import { localize } from 'vs/nls';
import { createCancelablePromise } from 'vs/base/common/async';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { CancellationToken } from 'vs/base/common/cancellation';
import { OS, OperatingSystem } from 'vs/base/common/platform';
import { isUndefined } from 'vs/base/common/types';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { IFileSyncPreviewResult, AbstractJsonFileSynchroniser, IRemoteUserData } from 'vs/platform/userDataSync/common/abstractSynchronizer';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { URI } from 'vs/base/common/uri';

interface ISyncContent {
	mac?: string;
	linux?: string;
	windows?: string;
	all?: string;
}

export class KeybindingsSynchroniser extends AbstractJsonFileSynchroniser implements IUserDataSynchroniser {

	protected get conflictsPreviewResource(): URI { return this.environmentService.keybindingsSyncPreviewResource; }
	protected readonly version: number = 1;

	constructor(
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IUserDataSyncEnablementService userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IFileService fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IUserDataSyncUtilService userDataSyncUtilService: IUserDataSyncUtilService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(environmentService.keybindingsResource, SyncSource.Keybindings, 'keybindings', fileService, environmentService, userDataSyncStoreService, userDataSyncBackupStoreService, userDataSyncEnablementService, telemetryService, logService, userDataSyncUtilService, configurationService);
	}

	async pull(): Promise<void> {
		if (!this.isEnabled()) {
			this.logService.info('Keybindings: Skipped pulling keybindings as it is disabled.');
			return;
		}

		this.stop();

		try {
			this.logService.info('Keybindings: Started pulling keybindings...');
			this.setStatus(SyncStatus.Syncing);

			const lastSyncUserData = await this.getLastSyncUserData();
			const remoteUserData = await this.getRemoteUserData(lastSyncUserData);
			const content = remoteUserData.syncData !== null ? this.getKeybindingsContentFromSyncContent(remoteUserData.syncData.content) : null;

			if (content !== null) {
				const fileContent = await this.getLocalFileContent();
				this.syncPreviewResultPromise = createCancelablePromise(() => Promise.resolve<IFileSyncPreviewResult>({
					fileContent,
					remoteUserData,
					lastSyncUserData,
					content,
					hasConflicts: false,
					hasLocalChanged: true,
					hasRemoteChanged: false,
				}));
				await this.apply();
			}

			// No remote exists to pull
			else {
				this.logService.info('Keybindings: Remote keybindings does not exist.');
			}

			this.logService.info('Keybindings: Finished pulling keybindings.');
		} finally {
			this.setStatus(SyncStatus.Idle);
		}

	}

	async push(): Promise<void> {
		if (!this.isEnabled()) {
			this.logService.info('Keybindings: Skipped pushing keybindings as it is disabled.');
			return;
		}

		this.stop();

		try {
			this.logService.info('Keybindings: Started pushing keybindings...');
			this.setStatus(SyncStatus.Syncing);

			const fileContent = await this.getLocalFileContent();

			if (fileContent !== null) {
				const lastSyncUserData = await this.getLastSyncUserData();
				const remoteUserData = await this.getRemoteUserData(lastSyncUserData);
				this.syncPreviewResultPromise = createCancelablePromise(() => Promise.resolve<IFileSyncPreviewResult>({
					fileContent,
					remoteUserData,
					lastSyncUserData,
					content: fileContent.value.toString(),
					hasLocalChanged: false,
					hasRemoteChanged: true,
					hasConflicts: false,
				}));
				await this.apply(true);
			}

			// No local exists to push
			else {
				this.logService.info('Keybindings: Local keybindings does not exist.');
			}

			this.logService.info('Keybindings: Finished pushing keybindings.');
		} finally {
			this.setStatus(SyncStatus.Idle);
		}

	}

	async accept(content: string): Promise<void> {
		if (this.status === SyncStatus.HasConflicts) {
			const preview = await this.syncPreviewResultPromise!;
			this.cancel();
			this.syncPreviewResultPromise = createCancelablePromise(async () => ({ ...preview, content }));
			await this.apply(true);
			this.setStatus(SyncStatus.Idle);
		}
	}

	async hasLocalData(): Promise<boolean> {
		try {
			const localFileContent = await this.getLocalFileContent();
			if (localFileContent) {
				const keybindings = parse(localFileContent.value.toString());
				if (isNonEmptyArray(keybindings)) {
					return true;
				}
			}
		} catch (error) {
			if ((<FileOperationError>error).fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) {
				return true;
			}
		}
		return false;
	}

	async getRemoteContentFromPreview(): Promise<string | null> {
		const content = await super.getRemoteContentFromPreview();
		return content !== null ? this.getKeybindingsContentFromSyncContent(content) : null;
	}

	async getRemoteContent(ref?: string, fragment?: string): Promise<string | null> {
		const content = await super.getRemoteContent(ref);
		if (content !== null && fragment) {
			return this.getFragment(content, fragment);
		}
		return content;
	}

	async getLocalBackupContent(ref?: string, fragment?: string): Promise<string | null> {
		let content = await super.getLocalBackupContent(ref);
		if (content !== null && fragment) {
			return this.getFragment(content, fragment);
		}
		return content;
	}

	private getFragment(content: string, fragment: string): string | null {
		const syncData = this.parseSyncData(content);
		if (syncData) {
			switch (fragment) {
				case 'keybindings':
					return this.getKeybindingsContentFromSyncContent(syncData.content);
			}
		}
		return null;
	}

	protected async performSync(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null): Promise<SyncStatus> {
		try {
			const result = await this.getPreview(remoteUserData, lastSyncUserData);
			if (result.hasConflicts) {
				return SyncStatus.HasConflicts;
			}
			await this.apply();
			return SyncStatus.Idle;
		} catch (e) {
			this.syncPreviewResultPromise = null;
			if (e instanceof UserDataSyncError) {
				switch (e.code) {
					case UserDataSyncErrorCode.LocalPreconditionFailed:
						// Rejected as there is a new local version. Syncing again.
						this.logService.info('Keybindings: Failed to synchronize keybindings as there is a new local version available. Synchronizing again...');
						return this.performSync(remoteUserData, lastSyncUserData);
				}
			}
			throw e;
		}
	}

	private async apply(forcePush?: boolean): Promise<void> {
		if (!this.syncPreviewResultPromise) {
			return;
		}

		let { fileContent, remoteUserData, lastSyncUserData, content, hasLocalChanged, hasRemoteChanged } = await this.syncPreviewResultPromise;

		if (content !== null) {
			if (this.hasErrors(content)) {
				throw new UserDataSyncError(localize('errorInvalidSettings', "Unable to sync keybindings as there are errors/warning in keybindings file."), UserDataSyncErrorCode.LocalInvalidContent, this.source);
			}

			if (hasLocalChanged) {
				this.logService.trace('Keybindings: Updating local keybindings...');
				await this.backupLocal(this.toSyncContent(content, null));
				await this.updateLocalFileContent(content, fileContent);
				this.logService.info('Keybindings: Updated local keybindings');
			}

			if (hasRemoteChanged) {
				this.logService.trace('Keybindings: Updating remote keybindings...');
				const remoteContents = this.toSyncContent(content, remoteUserData.syncData ? remoteUserData.syncData.content : null);
				remoteUserData = await this.updateRemoteUserData(remoteContents, forcePush ? null : remoteUserData.ref);
				this.logService.info('Keybindings: Updated remote keybindings');
			}

			// Delete the preview
			try {
				await this.fileService.del(this.conflictsPreviewResource);
			} catch (e) { /* ignore */ }
		} else {
			this.logService.info('Keybindings: No changes found during synchronizing keybindings.');
		}

		if (lastSyncUserData?.ref !== remoteUserData.ref && (content !== null || fileContent !== null)) {
			this.logService.trace('Keybindings: Updating last synchronized keybindings...');
			const lastSyncContent = this.toSyncContent(content !== null ? content : fileContent!.value.toString(), null);
			await this.updateLastSyncUserData({ ref: remoteUserData.ref, syncData: { version: remoteUserData.syncData!.version, content: lastSyncContent } });
			this.logService.info('Keybindings: Updated last synchronized keybindings');
		}

		this.syncPreviewResultPromise = null;
	}

	private getPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null): Promise<IFileSyncPreviewResult> {
		if (!this.syncPreviewResultPromise) {
			this.syncPreviewResultPromise = createCancelablePromise(token => this.generatePreview(remoteUserData, lastSyncUserData, token));
		}
		return this.syncPreviewResultPromise;
	}

	private async generatePreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, token: CancellationToken): Promise<IFileSyncPreviewResult> {
		const remoteContent = remoteUserData.syncData ? this.getKeybindingsContentFromSyncContent(remoteUserData.syncData.content) : null;
		const lastSyncContent = lastSyncUserData && lastSyncUserData.syncData ? this.getKeybindingsContentFromSyncContent(lastSyncUserData.syncData.content) : null;
		// Get file content last to get the latest
		const fileContent = await this.getLocalFileContent();
		const formattingOptions = await this.getFormattingOptions();

		let content: string | null = null;
		let hasLocalChanged: boolean = false;
		let hasRemoteChanged: boolean = false;
		let hasConflicts: boolean = false;

		if (remoteContent) {
			const localContent: string = fileContent ? fileContent.value.toString() : '[]';
			if (this.hasErrors(localContent)) {
				throw new UserDataSyncError(localize('errorInvalidSettings', "Unable to sync keybindings as there are errors/warning in keybindings file."), UserDataSyncErrorCode.LocalInvalidContent, this.source);
			}

			if (!lastSyncContent // First time sync
				|| lastSyncContent !== localContent // Local has forwarded
				|| lastSyncContent !== remoteContent // Remote has forwarded
			) {
				this.logService.trace('Keybindings: Merging remote keybindings with local keybindings...');
				const result = await merge(localContent, remoteContent, lastSyncContent, formattingOptions, this.userDataSyncUtilService);
				// Sync only if there are changes
				if (result.hasChanges) {
					content = result.mergeContent;
					hasConflicts = result.hasConflicts;
					hasLocalChanged = hasConflicts || result.mergeContent !== localContent;
					hasRemoteChanged = hasConflicts || result.mergeContent !== remoteContent;
				}
			}
		}

		// First time syncing to remote
		else if (fileContent) {
			this.logService.trace('Keybindings: Remote keybindings does not exist. Synchronizing keybindings for the first time.');
			content = fileContent.value.toString();
			hasRemoteChanged = true;
		}

		if (content && !token.isCancellationRequested) {
			await this.fileService.writeFile(this.environmentService.keybindingsSyncPreviewResource, VSBuffer.fromString(content));
		}

		return { fileContent, remoteUserData, lastSyncUserData, content, hasLocalChanged, hasRemoteChanged, hasConflicts };
	}

	private getKeybindingsContentFromSyncContent(syncContent: string): string | null {
		try {
			const parsed = <ISyncContent>JSON.parse(syncContent);
			if (!this.configurationService.getValue<boolean>('sync.keybindingsPerPlatform')) {
				return isUndefined(parsed.all) ? null : parsed.all;
			}
			switch (OS) {
				case OperatingSystem.Macintosh:
					return isUndefined(parsed.mac) ? null : parsed.mac;
				case OperatingSystem.Linux:
					return isUndefined(parsed.linux) ? null : parsed.linux;
				case OperatingSystem.Windows:
					return isUndefined(parsed.windows) ? null : parsed.windows;
			}
		} catch (e) {
			this.logService.error(e);
			return null;
		}
	}

	private toSyncContent(keybindingsContent: string, syncContent: string | null): string {
		let parsed: ISyncContent = {};
		try {
			parsed = JSON.parse(syncContent || '{}');
		} catch (e) {
			this.logService.error(e);
		}
		if (!this.configurationService.getValue<boolean>('sync.keybindingsPerPlatform')) {
			parsed.all = keybindingsContent;
		} else {
			delete parsed.all;
		}
		switch (OS) {
			case OperatingSystem.Macintosh:
				parsed.mac = keybindingsContent;
				break;
			case OperatingSystem.Linux:
				parsed.linux = keybindingsContent;
				break;
			case OperatingSystem.Windows:
				parsed.windows = keybindingsContent;
				break;
		}
		return JSON.stringify(parsed);
	}

}
