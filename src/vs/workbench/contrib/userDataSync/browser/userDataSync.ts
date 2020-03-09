/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from 'vs/base/common/actions';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { canceled, isPromiseCanceledError } from 'vs/base/common/errors';
import { Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, dispose, MutableDisposable, toDisposable, IDisposable } from 'vs/base/common/lifecycle';
import { isWeb } from 'vs/base/common/platform';
import { isEqual } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import type { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { registerEditorContribution, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import type { IEditorContribution } from 'vs/editor/common/editorCommon';
import type { ITextModel } from 'vs/editor/common/model';
import { AuthenticationSession } from 'vs/editor/common/modes';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ITextModelContentProvider, ITextModelService } from 'vs/editor/common/services/resolverService';
import { localize } from 'vs/nls';
import { MenuId, MenuRegistry, registerAction2, Action2 } from 'vs/platform/actions/common/actions';
import { CommandsRegistry, ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IFileService } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { CONTEXT_SYNC_STATE, getUserDataSyncStore, ISyncConfiguration, IUserDataAutoSyncService, IUserDataSyncService, IUserDataSyncStore, registerConfiguration, SyncSource, SyncStatus, UserDataSyncError, UserDataSyncErrorCode, USER_DATA_SYNC_SCHEME, IUserDataSyncEnablementService, ResourceKey, getSyncSourceFromPreviewResource, CONTEXT_SYNC_ENABLEMENT, toRemoteSyncResourceFromSource, PREVIEW_QUERY, resolveSyncResource, getSyncSourceFromResourceKey } from 'vs/platform/userDataSync/common/userDataSync';
import { FloatingClickWidget } from 'vs/workbench/browser/parts/editor/editorWidgets';
import { GLOBAL_ACTIVITY_ID } from 'vs/workbench/common/activity';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IEditorInput, toResource, SideBySideEditor } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import * as Constants from 'vs/workbench/contrib/logs/common/logConstants';
import { IOutputService } from 'vs/workbench/contrib/output/common/output';
import { UserDataSyncTrigger } from 'vs/workbench/contrib/userDataSync/browser/userDataSyncTrigger';
import { IActivityService, IBadge, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { IAuthenticationService } from 'vs/workbench/services/authentication/browser/authenticationService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IPreferencesService } from 'vs/workbench/services/preferences/common/preferences';
import { IAuthenticationTokenService } from 'vs/platform/authentication/common/authentication';
import { fromNow } from 'vs/base/common/date';
import { IProductService } from 'vs/platform/product/common/productService';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { timeout } from 'vs/base/common/async';

const enum AuthStatus {
	Initializing = 'Initializing',
	SignedIn = 'SignedIn',
	SignedOut = 'SignedOut',
	Unavailable = 'Unavailable'
}
const CONTEXT_AUTH_TOKEN_STATE = new RawContextKey<string>('authTokenStatus', AuthStatus.Initializing);
const CONTEXT_CONFLICTS_SOURCES = new RawContextKey<string>('conflictsSources', '');

type ConfigureSyncQuickPickItem = { id: ResourceKey, label: string, description?: string };

function getSyncAreaLabel(source: SyncSource): string {
	switch (source) {
		case SyncSource.Settings: return localize('settings', "Settings");
		case SyncSource.Keybindings: return localize('keybindings', "Keyboard Shortcuts");
		case SyncSource.Extensions: return localize('extensions', "Extensions");
		case SyncSource.GlobalState: return localize('ui state label', "UI State");
	}
}

type SyncConflictsClassification = {
	source: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
	action?: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

type FirstTimeSyncClassification = {
	action: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

const getActivityTitle = (label: string, userDataSyncService: IUserDataSyncService): string => {
	if (userDataSyncService.status === SyncStatus.Syncing) {
		return localize('sync is on with syncing', "{0} (syncing)", label);
	}
	if (userDataSyncService.lastSyncTime) {
		return localize('sync is on with time', "{0} (synced {1})", label, fromNow(userDataSyncService.lastSyncTime, true));
	}
	return label;
};
const getIdentityTitle = (label: string, authenticationProviderId: string, account: AuthenticationSession | undefined, authenticationService: IAuthenticationService): string => {
	return account ? `${label} (${authenticationService.getDisplayName(authenticationProviderId)}:${account.accountName})` : label;
};
const turnOnSyncCommand = { id: 'workbench.userData.actions.syncStart', title: localize('turn on sync with category', "Sync: Turn on Sync") };
const signInCommand = { id: 'workbench.userData.actions.signin', title: localize('sign in', "Sync: Sign in to sync") };
const stopSyncCommand = { id: 'workbench.userData.actions.stopSync', title(authenticationProviderId: string, account: AuthenticationSession | undefined, authenticationService: IAuthenticationService) { return getIdentityTitle(localize('stop sync', "Sync: Turn off Sync"), authenticationProviderId, account, authenticationService); } };
const resolveSettingsConflictsCommand = { id: 'workbench.userData.actions.resolveSettingsConflicts', title: localize('showConflicts', "Sync: Show Settings Conflicts") };
const resolveKeybindingsConflictsCommand = { id: 'workbench.userData.actions.resolveKeybindingsConflicts', title: localize('showKeybindingsConflicts', "Sync: Show Keybindings Conflicts") };
const configureSyncCommand = { id: 'workbench.userData.actions.configureSync', title: localize('configure sync', "Sync: Configure") };
const showSyncActivityCommand = {
	id: 'workbench.userData.actions.showSyncActivity', title(userDataSyncService: IUserDataSyncService): string {
		return getActivityTitle(localize('show sync log', "Sync: Show Log"), userDataSyncService);
	}
};
const showSyncSettingsCommand = { id: 'workbench.userData.actions.syncSettings', title: localize('sync settings', "Sync: Settings"), };

export class UserDataSyncWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	private readonly userDataSyncStore: IUserDataSyncStore | undefined;
	private readonly syncEnablementContext: IContextKey<boolean>;
	private readonly syncStatusContext: IContextKey<string>;
	private readonly authenticationState: IContextKey<string>;
	private readonly conflictsSources: IContextKey<string>;

	private readonly badgeDisposable = this._register(new MutableDisposable());
	private readonly signInNotificationDisposable = this._register(new MutableDisposable());
	private _activeAccount: AuthenticationSession | undefined;

	constructor(
		@IUserDataSyncEnablementService private readonly userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActivityService private readonly activityService: IActivityService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOutputService private readonly outputService: IOutputService,
		@IAuthenticationTokenService private readonly authTokenService: IAuthenticationTokenService,
		@IUserDataAutoSyncService userDataAutoSyncService: IUserDataAutoSyncService,
		@ITextModelService textModelResolverService: ITextModelService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IFileService private readonly fileService: IFileService,
		@IProductService private readonly productService: IProductService,
		@IStorageService private readonly storageService: IStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.userDataSyncStore = getUserDataSyncStore(productService, configurationService);
		this.syncEnablementContext = CONTEXT_SYNC_ENABLEMENT.bindTo(contextKeyService);
		this.syncStatusContext = CONTEXT_SYNC_STATE.bindTo(contextKeyService);
		this.authenticationState = CONTEXT_AUTH_TOKEN_STATE.bindTo(contextKeyService);
		this.conflictsSources = CONTEXT_CONFLICTS_SOURCES.bindTo(contextKeyService);
		if (this.userDataSyncStore) {
			registerConfiguration();
			this.onDidChangeSyncStatus(this.userDataSyncService.status);
			this.onDidChangeConflicts(this.userDataSyncService.conflictsSources);
			this.onDidChangeEnablement(this.userDataSyncEnablementService.isEnabled());
			this._register(Event.debounce(userDataSyncService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeSyncStatus(this.userDataSyncService.status)));
			this._register(userDataSyncService.onDidChangeConflicts(() => this.onDidChangeConflicts(this.userDataSyncService.conflictsSources)));
			this._register(userDataSyncService.onSyncErrors(errors => this.onSyncErrors(errors)));
			this._register(this.authTokenService.onTokenFailed(_ => this.onTokenFailed()));
			this._register(this.userDataSyncEnablementService.onDidChangeEnablement(enabled => this.onDidChangeEnablement(enabled)));
			this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => this.onDidRegisterAuthenticationProvider(e)));
			this._register(this.authenticationService.onDidUnregisterAuthenticationProvider(e => this.onDidUnregisterAuthenticationProvider(e)));
			this._register(this.authenticationService.onDidChangeSessions(e => this.onDidChangeSessions(e)));
			this._register(userDataAutoSyncService.onError(error => this.onAutoSyncError(error)));
			this.registerActions();
			this.initializeActiveAccount().then(_ => {
				if (!isWeb) {
					this._register(instantiationService.createInstance(UserDataSyncTrigger).onDidTriggerSync(source => userDataAutoSyncService.triggerAutoSync([source])));
				}
			});

			textModelResolverService.registerTextModelContentProvider(USER_DATA_SYNC_SCHEME, instantiationService.createInstance(UserDataRemoteContentProvider));
			registerEditorContribution(AcceptChangesContribution.ID, AcceptChangesContribution);
		}
	}

	private async initializeActiveAccount(): Promise<void> {
		const sessions = await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId);
		// Auth provider has not yet been registered
		if (!sessions) {
			return;
		}

		if (sessions.length === 0) {
			await this.setActiveAccount(undefined);
			return;
		}

		if (sessions.length === 1) {
			this.logAuthenticatedEvent(sessions[0]);
			await this.setActiveAccount(sessions[0]);
			return;
		}

		const selectedAccount = await this.quickInputService.pick(sessions.map(session => {
			return {
				id: session.id,
				label: session.accountName
			};
		}), { canPickMany: false });

		if (selectedAccount) {
			const selected = sessions.filter(account => selectedAccount.id === account.id)[0];
			this.logAuthenticatedEvent(selected);
			await this.setActiveAccount(selected);
		}
	}

	private logAuthenticatedEvent(session: AuthenticationSession): void {
		type UserAuthenticatedClassification = {
			id: { classification: 'EndUserPseudonymizedInformation', purpose: 'BusinessInsight' };
		};

		type UserAuthenticatedEvent = {
			id: string;
		};

		const id = session.id.split('/')[1];
		this.telemetryService.publicLog2<UserAuthenticatedEvent, UserAuthenticatedClassification>('user.authenticated', { id });
	}

	get activeAccount(): AuthenticationSession | undefined {
		return this._activeAccount;
	}

	async setActiveAccount(account: AuthenticationSession | undefined) {
		this._activeAccount = account;

		if (account) {
			try {
				const token = await account.getAccessToken();
				this.authTokenService.setToken(token);
				this.authenticationState.set(AuthStatus.SignedIn);
			} catch (e) {
				this.authTokenService.setToken(undefined);
				this.authenticationState.set(AuthStatus.Unavailable);
			}
		} else {
			this.authTokenService.setToken(undefined);
			this.authenticationState.set(AuthStatus.SignedOut);
		}

		this.updateBadge();
	}

	private async onDidChangeSessions(providerId: string): Promise<void> {
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			if (this.activeAccount) {
				// Try to update existing account, case where access token has been refreshed
				const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
				const matchingAccount = accounts.filter(a => a.id === this.activeAccount?.id)[0];
				this.setActiveAccount(matchingAccount);
			} else {
				this.initializeActiveAccount();
			}
		}
	}

	private async onTokenFailed(): Promise<void> {
		if (this.activeAccount) {
			const accounts = (await this.authenticationService.getSessions(this.userDataSyncStore!.authenticationProviderId) || []);
			const matchingAccount = accounts.filter(a => a.id === this.activeAccount?.id)[0];
			this.setActiveAccount(matchingAccount);
		} else {
			this.setActiveAccount(undefined);
		}
	}

	private async onDidRegisterAuthenticationProvider(providerId: string) {
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			await this.initializeActiveAccount();
		}
	}

	private onDidUnregisterAuthenticationProvider(providerId: string) {
		if (providerId === this.userDataSyncStore!.authenticationProviderId) {
			this.setActiveAccount(undefined);
			this.authenticationState.reset();
		}
	}

	private onDidChangeSyncStatus(status: SyncStatus) {
		this.syncStatusContext.set(status);
		this.updateBadge();
	}

	private readonly conflictsDisposables = new Map<SyncSource, IDisposable>();
	private onDidChangeConflicts(conflicts: SyncSource[]) {
		this.updateBadge();
		if (conflicts.length) {
			this.conflictsSources.set(this.userDataSyncService.conflictsSources.join(','));

			// Clear and dispose conflicts those were cleared
			this.conflictsDisposables.forEach((disposable, conflictsSource) => {
				if (this.userDataSyncService.conflictsSources.indexOf(conflictsSource) === -1) {
					disposable.dispose();
					this.conflictsDisposables.delete(conflictsSource);
				}
			});

			for (const conflictsSource of this.userDataSyncService.conflictsSources) {
				const conflictsEditorInput = this.getConflictsEditorInput(conflictsSource);
				if (!conflictsEditorInput && !this.conflictsDisposables.has(conflictsSource)) {
					const conflictsArea = getSyncAreaLabel(conflictsSource);
					const handle = this.notificationService.prompt(Severity.Warning, localize('conflicts detected', "Unable to sync due to conflicts in {0}. Please resolve them to continue.", conflictsArea.toLowerCase()),
						[
							{
								label: localize('accept remote', "Accept Remote"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: conflictsSource, action: 'acceptRemote' });
									this.acceptRemote(conflictsSource);
								}
							},
							{
								label: localize('accept local', "Accept Local"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: conflictsSource, action: 'acceptLocal' });
									this.acceptLocal(conflictsSource);
								}
							},
							{
								label: localize('show conflicts', "Show Conflicts"),
								run: () => {
									this.telemetryService.publicLog2<{ source: string, action?: string }, SyncConflictsClassification>('sync/showConflicts', { source: conflictsSource });
									this.handleConflicts(conflictsSource);
								}
							}
						],
						{
							sticky: true
						}
					);
					this.conflictsDisposables.set(conflictsSource, toDisposable(() => {

						// close the conflicts warning notification
						handle.close();

						// close opened conflicts editor previews
						const conflictsEditorInput = this.getConflictsEditorInput(conflictsSource);
						if (conflictsEditorInput) {
							conflictsEditorInput.dispose();
						}

						this.conflictsDisposables.delete(conflictsSource);
					}));
				}
			}
		} else {
			this.conflictsSources.reset();
			this.getAllConflictsEditorInputs().forEach(input => input.dispose());
			this.conflictsDisposables.forEach(disposable => disposable.dispose());
			this.conflictsDisposables.clear();
		}
	}

	private async acceptRemote(syncSource: SyncSource) {
		try {
			const contents = await this.userDataSyncService.resolveContent(toRemoteSyncResourceFromSource(syncSource).with({ query: PREVIEW_QUERY }));
			if (contents) {
				await this.userDataSyncService.accept(syncSource, contents);
			}
		} catch (e) {
			this.notificationService.error(e);
		}
	}

	private async acceptLocal(syncSource: SyncSource): Promise<void> {
		try {
			const previewResource = syncSource === SyncSource.Settings
				? this.workbenchEnvironmentService.settingsSyncPreviewResource
				: syncSource === SyncSource.Keybindings
					? this.workbenchEnvironmentService.keybindingsSyncPreviewResource
					: null;
			if (previewResource) {
				const fileContent = await this.fileService.readFile(previewResource);
				if (fileContent) {
					this.userDataSyncService.accept(syncSource, fileContent.value.toString());
				}
			}
		} catch (e) {
			this.notificationService.error(e);
		}
	}

	private onDidChangeEnablement(enabled: boolean) {
		this.syncEnablementContext.set(enabled);
		this.updateBadge();
		if (enabled) {
			if (this.authenticationState.get() === AuthStatus.SignedOut) {
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				const handle = this.notificationService.prompt(Severity.Info, localize('sign in message', "Please sign in with your {0} account to continue sync", displayName),
					[
						{
							label: localize('Sign in', "Sign in"),
							run: () => this.signIn()
						}
					]);
				this.signInNotificationDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.signInNotificationDisposable.clear());
			}
		} else {
			this.signInNotificationDisposable.clear();
		}
	}

	private onAutoSyncError(error: UserDataSyncError): void {
		switch (error.code) {
			case UserDataSyncErrorCode.TurnedOff:
			case UserDataSyncErrorCode.SessionExpired:
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('turned off', "Sync was turned off from another device."),
					actions: {
						primary: [new Action('turn on sync', localize('turn on sync', "Turn on Sync"), undefined, true, () => this.turnOn())]
					}
				});
				return;
			case UserDataSyncErrorCode.TooLarge:
				if (error.source === SyncSource.Keybindings || error.source === SyncSource.Settings) {
					this.disableSync(error.source);
					const sourceArea = getSyncAreaLabel(error.source);
					this.notificationService.notify({
						severity: Severity.Error,
						message: localize('too large', "Disabled syncing {0} because size of the {1} file to sync is larger than {2}. Please open the file and reduce the size and enable sync", sourceArea.toLowerCase(), sourceArea.toLowerCase(), '100kb'),
						actions: {
							primary: [new Action('open sync file', localize('open file', "Open {0} File", sourceArea), undefined, true,
								() => error.source === SyncSource.Settings ? this.preferencesService.openGlobalSettings(true) : this.preferencesService.openGlobalKeybindingSettings(true))]
						}
					});
				}
				return;
			case UserDataSyncErrorCode.Incompatible:
				this.disableSync();
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('error incompatible', "Turned off sync because local data is incompatible with the data in the cloud. Please update {0} and turn on sync to continue syncing.", this.productService.nameLong),
				});
				return;
		}
	}

	private readonly invalidContentErrorDisposables = new Map<SyncSource, IDisposable>();
	private onSyncErrors(errors: [SyncSource, UserDataSyncError][]): void {
		if (errors.length) {
			for (const [source, error] of errors) {
				switch (error.code) {
					case UserDataSyncErrorCode.LocalInvalidContent:
						this.handleInvalidContentError(source);
						break;
					default:
						const disposable = this.invalidContentErrorDisposables.get(source);
						if (disposable) {
							disposable.dispose();
							this.invalidContentErrorDisposables.delete(source);
						}
				}
			}
		} else {
			this.invalidContentErrorDisposables.forEach(disposable => disposable.dispose());
			this.invalidContentErrorDisposables.clear();
		}
	}

	private handleInvalidContentError(source: SyncSource): void {
		if (this.invalidContentErrorDisposables.has(source)) {
			return;
		}
		if (source !== SyncSource.Settings && source !== SyncSource.Keybindings) {
			return;
		}
		const resource = source === SyncSource.Settings ? this.workbenchEnvironmentService.settingsResource : this.workbenchEnvironmentService.keybindingsResource;
		if (isEqual(resource, toResource(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.MASTER }))) {
			// Do not show notification if the file in error is active
			return;
		}
		const errorArea = getSyncAreaLabel(source);
		const handle = this.notificationService.notify({
			severity: Severity.Error,
			message: localize('errorInvalidConfiguration', "Unable to sync {0} because there are some errors/warnings in the file. Please open the file to correct errors/warnings in it.", errorArea.toLowerCase()),
			actions: {
				primary: [new Action('open sync file', localize('open file', "Open {0} File", errorArea), undefined, true,
					() => source === SyncSource.Settings ? this.preferencesService.openGlobalSettings(true) : this.preferencesService.openGlobalKeybindingSettings(true))]
			}
		});
		this.invalidContentErrorDisposables.set(source, toDisposable(() => {
			// close the error warning notification
			handle.close();
			this.invalidContentErrorDisposables.delete(source);
		}));
	}

	private async updateBadge(): Promise<void> {
		this.badgeDisposable.clear();

		let badge: IBadge | undefined = undefined;
		let clazz: string | undefined;
		let priority: number | undefined = undefined;

		if (this.userDataSyncService.status !== SyncStatus.Uninitialized && this.userDataSyncEnablementService.isEnabled() && this.authenticationState.get() === AuthStatus.SignedOut) {
			badge = new NumberBadge(1, () => localize('sign in to sync', "Sign in to Sync"));
		} else if (this.userDataSyncService.conflictsSources.length) {
			badge = new NumberBadge(this.userDataSyncService.conflictsSources.length, () => localize('has conflicts', "Sync: Conflicts Detected"));
		}

		if (badge) {
			this.badgeDisposable.value = this.activityService.showActivity(GLOBAL_ACTIVITY_ID, badge, clazz, priority);
		}
	}

	private async turnOn(): Promise<void> {
		if (!this.storageService.getBoolean('sync.donotAskPreviewConfirmation', StorageScope.GLOBAL, false)) {
			const result = await this.dialogService.show(
				Severity.Info,
				localize('sync preview message', "Synchronizing your preferences is a preview feature, please read the documentation before turning it on."),
				[
					localize('open doc', "Open Documentation"),
					localize('turn on sync', "Turn on Sync"),
					localize('cancel', "Cancel"),
				],
				{
					cancelId: 2
				}
			);
			switch (result.choice) {
				case 0: this.openerService.open(URI.parse('https://aka.ms/vscode-settings-sync-help')); return;
				case 2: return;
			}
		}
		return new Promise((c, e) => {
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<ConfigureSyncQuickPickItem>();
			disposables.add(quickPick);
			quickPick.title = localize('turn on title', "Sync: Turn On");
			quickPick.ok = false;
			quickPick.customButton = true;
			if (this.authenticationState.get() === AuthStatus.SignedIn) {
				quickPick.customLabel = localize('turn on', "Turn On");
			} else {
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				quickPick.description = localize('sign in and turn on sync detail', "Sign in with your {0} account to synchronize your data across devices.", displayName);
				quickPick.customLabel = localize('sign in and turn on sync', "Sign in & Turn on");
			}
			quickPick.placeholder = localize('configure sync placeholder', "Choose what to sync");
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			const items = this.getConfigureSyncQuickPickItems();
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => this.userDataSyncEnablementService.isResourceEnabled(item.id));
			disposables.add(Event.any(quickPick.onDidAccept, quickPick.onDidCustom)(async () => {
				if (quickPick.selectedItems.length) {
					this.updateConfiguration(items, quickPick.selectedItems);
					this.doTurnOn().then(c, e);
					quickPick.hide();
				}
			}));
			disposables.add(quickPick.onDidHide(() => disposables.dispose()));
			quickPick.show();
		});
	}

	private async doTurnOn(): Promise<void> {
		if (this.authenticationState.get() === AuthStatus.SignedIn) {
			await new Promise((c, e) => {
				const disposables: DisposableStore = new DisposableStore();
				const displayName = this.authenticationService.getDisplayName(this.userDataSyncStore!.authenticationProviderId);
				const quickPick = this.quickInputService.createQuickPick<{ id: string, label: string, description?: string, detail?: string }>();
				disposables.add(quickPick);
				const chooseAnotherItemId = 'chooseAnother';
				quickPick.title = localize('pick account', "{0}: Pick an account", displayName);
				quickPick.ok = false;
				quickPick.placeholder = localize('choose account placeholder', "Pick an account for syncing");
				quickPick.ignoreFocusOut = true;
				quickPick.items = [{
					id: 'existing',
					label: localize('existing', "{0}", this.activeAccount!.accountName),
					detail: localize('signed in', "Signed in"),
				}, {
					id: chooseAnotherItemId,
					label: localize('choose another', "Use another account")
				}];
				disposables.add(quickPick.onDidAccept(async () => {
					if (quickPick.selectedItems.length) {
						if (quickPick.selectedItems[0].id === chooseAnotherItemId) {
							await this.authenticationService.logout(this.userDataSyncStore!.authenticationProviderId, this.activeAccount!.id);
							await this.setActiveAccount(undefined);
						}
						quickPick.hide();
						c();
					}
				}));
				disposables.add(quickPick.onDidHide(() => disposables.dispose()));
				quickPick.show();
			});
		}
		if (this.authenticationState.get() === AuthStatus.SignedOut) {
			await this.signIn();
		}
		await this.handleFirstTimeSync();
		this.userDataSyncEnablementService.setEnablement(true);
		this.notificationService.info(localize('sync turned on', "Sync will happen automatically from now on."));
		this.storageService.store('sync.donotAskPreviewConfirmation', true, StorageScope.GLOBAL);
	}

	private getConfigureSyncQuickPickItems(): ConfigureSyncQuickPickItem[] {
		return [{
			id: 'settings',
			label: getSyncAreaLabel(SyncSource.Settings)
		}, {
			id: 'keybindings',
			label: getSyncAreaLabel(SyncSource.Keybindings)
		}, {
			id: 'extensions',
			label: getSyncAreaLabel(SyncSource.Extensions)
		}, {
			id: 'globalState',
			label: getSyncAreaLabel(SyncSource.GlobalState),
			description: localize('ui state description', "only 'Display Language' for now")
		}];
	}

	private updateConfiguration(items: ConfigureSyncQuickPickItem[], selectedItems: ReadonlyArray<ConfigureSyncQuickPickItem>): void {
		for (const item of items) {
			const wasEnabled = this.userDataSyncEnablementService.isResourceEnabled(item.id);
			const isEnabled = !!selectedItems.filter(selected => selected.id === item.id)[0];
			if (wasEnabled !== isEnabled) {
				this.userDataSyncEnablementService.setResourceEnablement(item.id!, isEnabled);
			}
		}
	}

	private async configureSyncOptions(): Promise<ISyncConfiguration> {
		return new Promise((c, e) => {
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<ConfigureSyncQuickPickItem>();
			disposables.add(quickPick);
			quickPick.title = localize('turn on sync', "Turn on Sync");
			quickPick.placeholder = localize('configure sync placeholder', "Choose what to sync");
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			quickPick.ok = true;
			const items = this.getConfigureSyncQuickPickItems();
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => this.userDataSyncEnablementService.isResourceEnabled(item.id));
			disposables.add(quickPick.onDidAccept(async () => {
				if (quickPick.selectedItems.length) {
					await this.updateConfiguration(items, quickPick.selectedItems);
					quickPick.hide();
				}
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				c();
			}));
			quickPick.show();
		});
	}

	private async handleFirstTimeSync(): Promise<void> {
		const isFirstSyncWithMerge = await this.userDataSyncService.isFirstTimeSyncWithMerge();
		if (!isFirstSyncWithMerge) {
			return;
		}
		const result = await this.dialogService.show(
			Severity.Info,
			localize('firs time sync', "Sync"),
			[
				localize('merge', "Merge"),
				localize('cancel', "Cancel"),
				localize('replace', "Replace Local"),
			],
			{
				cancelId: 1,
				detail: localize('first time sync detail', "It looks like this is the first time sync is set up.\nWould you like to merge or replace with the data from the cloud?"),
			}
		);
		switch (result.choice) {
			case 0:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'merge' });
				break;
			case 1:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'cancelled' });
				throw canceled();
			case 2:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'replace-local' });
				await this.userDataSyncService.pull();
				break;
		}
	}

	private async turnOff(): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'info',
			message: localize('turn off sync confirmation', "Turn off Sync"),
			detail: localize('turn off sync detail', "Your settings, keybindings, extensions and UI State will no longer be synced."),
			primaryButton: localize('turn off', "Turn Off"),
			checkbox: {
				label: localize('turn off sync everywhere', "Turn off sync on all your devices and clear the data from the cloud.")
			}
		});
		if (result.confirmed) {
			if (result.checkboxChecked) {
				this.telemetryService.publicLog2('sync/turnOffEveryWhere');
				await this.userDataSyncService.reset();
			} else {
				await this.userDataSyncService.resetLocal();
			}
			this.disableSync();
		}
	}

	private disableSync(source?: SyncSource): void {
		if (source === undefined) {
			this.userDataSyncEnablementService.setEnablement(false);
		} else {
			switch (source) {
				case SyncSource.Settings: return this.userDataSyncEnablementService.setResourceEnablement('settings', false);
				case SyncSource.Keybindings: return this.userDataSyncEnablementService.setResourceEnablement('keybindings', false);
				case SyncSource.Extensions: return this.userDataSyncEnablementService.setResourceEnablement('extensions', false);
				case SyncSource.GlobalState: return this.userDataSyncEnablementService.setResourceEnablement('globalState', false);
			}
		}
	}

	private async signIn(): Promise<void> {
		try {
			await this.setActiveAccount(await this.authenticationService.login(this.userDataSyncStore!.authenticationProviderId, ['https://management.core.windows.net/.default', 'offline_access']));
		} catch (e) {
			this.notificationService.error(localize('loginFailed', "Logging in failed: {0}", e));
			throw e;
		}
	}

	private getConflictsEditorInput(source: SyncSource): IEditorInput | undefined {
		const previewResource = source === SyncSource.Settings ? this.workbenchEnvironmentService.settingsSyncPreviewResource
			: source === SyncSource.Keybindings ? this.workbenchEnvironmentService.keybindingsSyncPreviewResource
				: null;
		return previewResource ? this.editorService.editors.filter(input => input instanceof DiffEditorInput && isEqual(previewResource, input.master.resource))[0] : undefined;
	}

	private getAllConflictsEditorInputs(): IEditorInput[] {
		return this.editorService.editors.filter(input => {
			const resource = input instanceof DiffEditorInput ? input.master.resource : input.resource;
			return isEqual(resource, this.workbenchEnvironmentService.settingsSyncPreviewResource) || isEqual(resource, this.workbenchEnvironmentService.keybindingsSyncPreviewResource);
		});
	}

	private async handleConflicts(source: SyncSource): Promise<void> {
		let previewResource: URI | undefined = undefined;
		let label: string = '';
		if (source === SyncSource.Settings) {
			previewResource = this.workbenchEnvironmentService.settingsSyncPreviewResource;
			label = localize('settings conflicts preview', "Settings Conflicts (Remote ↔ Local)");
		} else if (source === SyncSource.Keybindings) {
			previewResource = this.workbenchEnvironmentService.keybindingsSyncPreviewResource;
			label = localize('keybindings conflicts preview', "Keybindings Conflicts (Remote ↔ Local)");
		}
		if (previewResource) {
			const remoteContentResource = toRemoteSyncResourceFromSource(source).with({ query: PREVIEW_QUERY });
			await this.editorService.openEditor({
				leftResource: remoteContentResource,
				rightResource: previewResource,
				label,
				options: {
					preserveFocus: false,
					pinned: true,
					revealIfVisible: true,
				},
			});
		}
	}

	private showSyncActivity(): Promise<void> {
		return this.outputService.showChannel(Constants.userDataSyncLogChannelId);
	}

	private registerActions(): void {
		this.registerTurnOnSyncAction();
		this.registerSignInAction();
		this.registerShowSettingsConflictsAction();
		this.registerShowKeybindingsConflictsAction();
		this.registerSyncStatusAction();

		this.registerTurnOffSyncAction();
		this.registerConfigureSyncAction();
		this.registerShowActivityAction();
		this.registerShowSettingsAction();
	}

	private registerTurnOnSyncAction(): void {
		const turnOnSyncWhenContext = ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT.toNegated(), CONTEXT_AUTH_TOKEN_STATE.notEqualsTo(AuthStatus.Initializing));
		CommandsRegistry.registerCommand(turnOnSyncCommand.id, async () => {
			try {
				await this.turnOn();
			} catch (e) {
				if (!isPromiseCanceledError(e)) {
					this.notificationService.error(localize('turn on failed', "Error while starting Sync: {0}", toErrorMessage(e)));
				}
			}
		});
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: turnOnSyncCommand.id,
				title: localize('global activity turn on sync', "Turn on Sync...")
			},
			when: turnOnSyncWhenContext,
			order: 1
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: turnOnSyncCommand,
			when: turnOnSyncWhenContext,
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: turnOnSyncCommand.id,
				title: localize('global activity turn on sync', "Turn on Sync...")
			},
			when: turnOnSyncWhenContext,
		});
	}

	private registerSignInAction(): void {
		const that = this;
		this._register(registerAction2(class StopSyncAction extends Action2 {
			constructor() {
				super({
					id: signInCommand.id,
					title: signInCommand.title,
					menu: {
						group: '5_sync',
						id: MenuId.GlobalActivity,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT, CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthStatus.SignedOut)),
						order: 2
					},
				});
			}
			async run(): Promise<any> {
				try {
					await that.signIn();
				} catch (e) {
					that.notificationService.error(e);
				}
			}
		}));
	}

	private registerShowSettingsConflictsAction(): void {
		const resolveSettingsConflictsWhenContext = ContextKeyExpr.regex(CONTEXT_CONFLICTS_SOURCES.keys()[0], /.*settings.*/i);
		CommandsRegistry.registerCommand(resolveSettingsConflictsCommand.id, () => this.handleConflicts(SyncSource.Settings));
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveSettingsConflictsCommand.id,
				title: localize('resolveConflicts_global', "Sync: Show Settings Conflicts (1)"),
			},
			when: resolveSettingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: resolveSettingsConflictsCommand.id,
				title: localize('resolveConflicts_global', "Sync: Show Settings Conflicts (1)"),
			},
			when: resolveSettingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: resolveSettingsConflictsCommand,
			when: resolveSettingsConflictsWhenContext,
		});
	}

	private registerShowKeybindingsConflictsAction(): void {
		const resolveKeybindingsConflictsWhenContext = ContextKeyExpr.regex(CONTEXT_CONFLICTS_SOURCES.keys()[0], /.*keybindings.*/i);
		CommandsRegistry.registerCommand(resolveKeybindingsConflictsCommand.id, () => this.handleConflicts(SyncSource.Keybindings));
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveKeybindingsConflictsCommand.id,
				title: localize('resolveKeybindingsConflicts_global', "Sync: Show Keybindings Conflicts (1)"),
			},
			when: resolveKeybindingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
			group: '5_sync',
			command: {
				id: resolveKeybindingsConflictsCommand.id,
				title: localize('resolveKeybindingsConflicts_global', "Sync: Show Keybindings Conflicts (1)"),
			},
			when: resolveKeybindingsConflictsWhenContext,
			order: 2
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: resolveKeybindingsConflictsCommand,
			when: resolveKeybindingsConflictsWhenContext,
		});

	}

	private registerSyncStatusAction(): void {
		const that = this;
		const when = ContextKeyExpr.and(CONTEXT_SYNC_ENABLEMENT, CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthStatus.SignedIn), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized));
		this._register(registerAction2(class SyncStatusAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.userData.actions.syncStatus',
					title: localize('sync is on', "Sync is on"),
					menu: [
						{
							id: MenuId.GlobalActivity,
							group: '5_sync',
							when,
							order: 3
						},
						{
							id: MenuId.MenubarPreferencesMenu,
							group: '5_sync',
							when,
							order: 3,
						}
					],
				});
			}
			run(accessor: ServicesAccessor): any {
				return new Promise((c, e) => {
					const quickInputService = accessor.get(IQuickInputService);
					const commandService = accessor.get(ICommandService);
					const disposables = new DisposableStore();
					const quickPick = quickInputService.createQuickPick();
					disposables.add(quickPick);
					const items: Array<IQuickPickItem | IQuickPickSeparator> = [];
					if (that.userDataSyncService.conflictsSources.length) {
						for (const source of that.userDataSyncService.conflictsSources) {
							switch (source) {
								case SyncSource.Settings:
									items.push({ id: resolveSettingsConflictsCommand.id, label: resolveSettingsConflictsCommand.title });
									break;
								case SyncSource.Keybindings:
									items.push({ id: resolveKeybindingsConflictsCommand.id, label: resolveKeybindingsConflictsCommand.title });
									break;
							}
						}
						items.push({ type: 'separator' });
					}
					items.push({ id: configureSyncCommand.id, label: configureSyncCommand.title });
					items.push({ id: showSyncSettingsCommand.id, label: showSyncSettingsCommand.title });
					items.push({ id: showSyncActivityCommand.id, label: showSyncActivityCommand.title(that.userDataSyncService) });
					items.push({ type: 'separator' });
					items.push({ id: stopSyncCommand.id, label: stopSyncCommand.title(that.userDataSyncStore!.authenticationProviderId, that.activeAccount, that.authenticationService) });
					quickPick.items = items;
					disposables.add(quickPick.onDidAccept(() => {
						if (quickPick.selectedItems[0] && quickPick.selectedItems[0].id) {
							// Introduce timeout as workaround - #91661 #91740
							timeout(0).then(() => commandService.executeCommand(quickPick.selectedItems[0].id!));
						}
						quickPick.hide();
					}));
					disposables.add(quickPick.onDidHide(() => {
						disposables.dispose();
						c();
					}));
					quickPick.show();
				});
			}
		}));
	}

	private registerTurnOffSyncAction(): void {
		const that = this;
		this._register(registerAction2(class StopSyncAction extends Action2 {
			constructor() {
				super({
					id: stopSyncCommand.id,
					title: stopSyncCommand.title(that.userDataSyncStore!.authenticationProviderId, that.activeAccount, that.authenticationService),
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT),
					},
				});
			}
			async run(): Promise<any> {
				try {
					await that.turnOff();
				} catch (e) {
					if (!isPromiseCanceledError(e)) {
						that.notificationService.error(localize('turn off failed', "Error while turning off sync: {0}", toErrorMessage(e)));
					}
				}
			}
		}));
	}

	private registerConfigureSyncAction(): void {
		const that = this;
		this._register(registerAction2(class ShowSyncActivityAction extends Action2 {
			constructor() {
				super({
					id: configureSyncCommand.id,
					title: configureSyncCommand.title,
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_ENABLEMENT),
					},
				});
			}
			run(): any { return that.configureSyncOptions(); }
		}));
	}

	private registerShowActivityAction(): void {
		const that = this;
		this._register(registerAction2(class ShowSyncActivityAction extends Action2 {
			constructor() {
				super({
					id: showSyncActivityCommand.id,
					get title() { return showSyncActivityCommand.title(that.userDataSyncService); },
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized)),
					},
				});
			}
			run(): any { return that.showSyncActivity(); }
		}));
	}

	private registerShowSettingsAction(): void {
		this._register(registerAction2(class ShowSyncSettingsAction extends Action2 {
			constructor() {
				super({
					id: showSyncSettingsCommand.id,
					title: showSyncSettingsCommand.title,
					menu: {
						id: MenuId.CommandPalette,
						when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized)),
					},
				});
			}
			run(accessor: ServicesAccessor): any {
				accessor.get(IPreferencesService).openGlobalSettings(false, { query: '@tag:sync' });
			}
		}));
	}

}

class UserDataRemoteContentProvider implements ITextModelContentProvider {

	constructor(
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IModelService private readonly modelService: IModelService,
		@IModeService private readonly modeService: IModeService,
	) {
	}

	provideTextContent(uri: URI): Promise<ITextModel> | null {
		if (uri.scheme === USER_DATA_SYNC_SCHEME) {
			return this.userDataSyncService.resolveContent(uri).then(content => this.modelService.createModel(content || '', this.modeService.create('jsonc'), uri));
		}
		return null;
	}
}

class AcceptChangesContribution extends Disposable implements IEditorContribution {

	static get(editor: ICodeEditor): AcceptChangesContribution {
		return editor.getContribution<AcceptChangesContribution>(AcceptChangesContribution.ID);
	}

	public static readonly ID = 'editor.contrib.acceptChangesButton';

	private acceptChangesButton: FloatingClickWidget | undefined;

	constructor(
		private editor: ICodeEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		super();

		this.update();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.editor.onDidChangeModel(e => this.update()));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('diffEditor.renderSideBySide'))(() => this.update()));
	}

	private update(): void {
		if (!this.shouldShowButton(this.editor)) {
			this.disposeAcceptChangesWidgetRenderer();
			return;
		}

		this.createAcceptChangesWidgetRenderer();
	}

	private shouldShowButton(editor: ICodeEditor): boolean {
		const model = editor.getModel();
		if (!model) {
			return false; // we need a model
		}

		if (getSyncSourceFromPreviewResource(model.uri, this.environmentService) !== undefined) {
			return true;
		}

		if (resolveSyncResource(model.uri) !== null && model.uri.query === PREVIEW_QUERY) {
			return this.configurationService.getValue<boolean>('diffEditor.renderSideBySide');
		}

		return false;
	}


	private createAcceptChangesWidgetRenderer(): void {
		if (!this.acceptChangesButton) {
			const isRemote = resolveSyncResource(this.editor.getModel()!.uri) !== null;
			const acceptRemoteLabel = localize('accept remote', "Accept Remote");
			const acceptLocalLabel = localize('accept local', "Accept Local");
			this.acceptChangesButton = this.instantiationService.createInstance(FloatingClickWidget, this.editor, isRemote ? acceptRemoteLabel : acceptLocalLabel, null);
			this._register(this.acceptChangesButton.onClick(async () => {
				const model = this.editor.getModel();
				if (model) {
					const conflictsSource = (getSyncSourceFromPreviewResource(model.uri, this.environmentService) || getSyncSourceFromResourceKey(resolveSyncResource(model.uri)!.resourceKey))!;
					this.telemetryService.publicLog2<{ source: string, action: string }, SyncConflictsClassification>('sync/handleConflicts', { source: conflictsSource, action: isRemote ? 'acceptRemote' : 'acceptLocal' });
					const syncAreaLabel = getSyncAreaLabel(conflictsSource);
					const result = await this.dialogService.confirm({
						type: 'info',
						title: isRemote
							? localize('Sync accept remote', "Sync: {0}", acceptRemoteLabel)
							: localize('Sync accept local', "Sync: {0}", acceptLocalLabel),
						message: isRemote
							? localize('confirm replace and overwrite local', "Would you like to accept remote {0} and replace local {1}?", syncAreaLabel.toLowerCase(), syncAreaLabel.toLowerCase())
							: localize('confirm replace and overwrite remote', "Would you like to accept local {0} and replace remote {1}?", syncAreaLabel.toLowerCase(), syncAreaLabel.toLowerCase()),
						primaryButton: isRemote ? acceptRemoteLabel : acceptLocalLabel
					});
					if (result.confirmed) {
						try {
							await this.userDataSyncService.accept(conflictsSource, model.getValue());
						} catch (e) {
							if (e instanceof UserDataSyncError && e.code === UserDataSyncErrorCode.LocalPreconditionFailed) {
								if (this.userDataSyncService.conflictsSources.indexOf(conflictsSource) !== -1) {
									this.notificationService.warn(localize('update conflicts', "Could not resolve conflicts as there is new local version available. Please try again."));
								}
							} else {
								this.notificationService.error(e);
							}
						}
					}
				}
			}));

			this.acceptChangesButton.render();
		}
	}

	private disposeAcceptChangesWidgetRenderer(): void {
		dispose(this.acceptChangesButton);
		this.acceptChangesButton = undefined;
	}

	dispose(): void {
		this.disposeAcceptChangesWidgetRenderer();
		super.dispose();
	}
}
