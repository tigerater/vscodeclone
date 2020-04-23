/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from 'vs/workbench/services/authentication/browser/authenticationService';
import { IQuickInputService, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IAuthenticationTokenService } from 'vs/platform/authentication/common/authentication';
import { IProductService } from 'vs/platform/product/common/productService';
import { IStorageService, StorageScope, IWorkspaceStorageChangeEvent } from 'vs/platform/storage/common/storage';
import { localize } from 'vs/nls';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { AuthenticationSession, AuthenticationSessionsChangeEvent } from 'vs/editor/common/modes';
import { Event, Emitter } from 'vs/base/common/event';
import { getUserDataSyncStore, IUserDataSyncEnablementService, IAuthenticationProvider, isAuthenticationProvider } from 'vs/platform/userDataSync/common/userDataSync';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { values } from 'vs/base/common/map';
import { ILogService } from 'vs/platform/log/common/log';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { flatten } from 'vs/base/common/arrays';

type UserAccountClassification = {
	id: { classification: 'EndUserPseudonymizedInformation', purpose: 'BusinessInsight' };
};

type UserAccountEvent = {
	id: string;
};

type AccountQuickPickItem = { label: string, authenticationProvider: IAuthenticationProvider, account?: IUserDataSyncAccount, detail?: string };

export interface IUserDataSyncAccount {
	readonly providerId: string;
	readonly sessionId: string;
	readonly accountName: string;
}

export const enum AccountStatus {
	Uninitialized = 'uninitialized',
	Unavailable = 'unavailable',
	Available = 'available',
}

export class UserDataSyncAccounts extends Disposable {

	private static CACHED_SESSION_STORAGE_KEY = 'userDataSyncAccountPreference';

	_serviceBrand: any;

	readonly authenticationProviders: IAuthenticationProvider[];

	private _status: AccountStatus = AccountStatus.Uninitialized;
	get status(): AccountStatus { return this._status; }
	private readonly _onDidChangeStatus = this._register(new Emitter<AccountStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _onDidSignOut = this._register(new Emitter<void>());
	readonly onDidSignOut = this._onDidSignOut.event;

	private _all: Map<string, IUserDataSyncAccount[]> = new Map<string, IUserDataSyncAccount[]>();
	get all(): IUserDataSyncAccount[] { return flatten(values(this._all)); }

	get current(): IUserDataSyncAccount | undefined { return this.all.filter(({ sessionId }) => sessionId === this.currentSessionId)[0]; }

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IAuthenticationTokenService private readonly authenticationTokenService: IAuthenticationTokenService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@IUserDataSyncEnablementService private readonly userDataSyncEnablementService: IUserDataSyncEnablementService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExtensionService extensionService: IExtensionService,
	) {
		super();
		this.authenticationProviders = getUserDataSyncStore(productService, configurationService)?.authenticationProviders || [];
		if (this.authenticationProviders.length) {
			extensionService.whenInstalledExtensionsRegistered().then(() => {
				if (this.authenticationProviders.some(({ id }) => authenticationService.isAuthenticationProviderRegistered(id))) {
					this.initialize();
				} else {
					this._register(Event.once(Event.filter(this.authenticationService.onDidRegisterAuthenticationProvider, providerId => this.isSupportedAuthenticationProviderId(providerId)))(() => this.initialize()));
				}
			});
		}
	}

	private async initialize(): Promise<void> {
		await this.update();

		this._register(
			Event.any(
				Event.filter(
					Event.any(
						this.authenticationService.onDidRegisterAuthenticationProvider,
						this.authenticationService.onDidUnregisterAuthenticationProvider,
					), providerId => this.isSupportedAuthenticationProviderId(providerId)),
				this.authenticationTokenService.onTokenFailed)
				(() => this.update()));

		this._register(Event.filter(this.authenticationService.onDidChangeSessions, e => this.isSupportedAuthenticationProviderId(e.providerId))(({ event }) => this.onDidChangeSessions(event)));
		this._register(this.storageService.onDidChangeStorage(e => this.onDidChangeStorage(e)));
	}

	private isSupportedAuthenticationProviderId(authenticationProviderId: string): boolean {
		return this.authenticationProviders.some(({ id }) => id === authenticationProviderId);
	}

	private async update(): Promise<void> {
		const allAccounts: Map<string, IUserDataSyncAccount[]> = new Map<string, IUserDataSyncAccount[]>();
		for (const { id } of this.authenticationProviders) {
			const accounts = await this.getAccounts(id);
			allAccounts.set(id, accounts);
		}

		this._all = allAccounts;
		const status = this.current ? AccountStatus.Available : AccountStatus.Unavailable;

		if (this._status !== status) {
			const previous = this._status;
			this.logService.debug('Sync account status changed', previous, status);

			if (previous === AccountStatus.Available && status === AccountStatus.Unavailable) {
				this._onDidSignOut.fire();
			}

			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}

	private async getAccounts(authenticationProviderId: string): Promise<IUserDataSyncAccount[]> {

		let accounts: Map<string, IUserDataSyncAccount> = new Map<string, IUserDataSyncAccount>();
		let currentAccount: IUserDataSyncAccount | null = null;
		let currentSession: AuthenticationSession | undefined = undefined;

		const sessions = await this.authenticationService.getSessions(authenticationProviderId) || [];
		for (const session of sessions) {
			const account: IUserDataSyncAccount = { providerId: authenticationProviderId, sessionId: session.id, accountName: session.accountName };
			accounts.set(account.accountName, account);
			if (session.id === this.currentSessionId) {
				currentSession = session;
				currentAccount = account;
			}
		}

		if (currentAccount) {
			// Always use current account if available
			accounts.set(currentAccount.accountName, currentAccount);
		}

		// update access token
		if (currentSession) {
			try {
				const token = await currentSession.getAccessToken();
				await this.authenticationTokenService.setToken(token);
			} catch (e) {
				this.logService.error(e);
			}
		}

		return values(accounts);
	}

	async pick(): Promise<boolean> {
		const result = await this.doPick();
		if (!result) {
			return false;
		}
		let sessionId: string, accountName: string;
		if (isAuthenticationProvider(result)) {
			const session = await this.authenticationService.login(result.id, result.scopes);
			sessionId = session.id;
			accountName = session.accountName;
		} else {
			sessionId = result.sessionId;
			accountName = result.accountName;
		}
		await this.switch(sessionId, accountName);
		return true;
	}

	private async doPick(): Promise<IUserDataSyncAccount | IAuthenticationProvider | undefined> {
		if (this.authenticationProviders.length === 0) {
			return undefined;
		}

		await this.update();

		// Single auth provider and no accounts available
		if (this.authenticationProviders.length === 1 && !this.all.length) {
			return this.authenticationProviders[0];
		}

		return new Promise<IUserDataSyncAccount | IAuthenticationProvider | undefined>(async (c, e) => {
			let result: IUserDataSyncAccount | IAuthenticationProvider | undefined;
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<AccountQuickPickItem>();
			disposables.add(quickPick);

			quickPick.title = localize('pick an account', "Preferences Sync: Pick an account");
			quickPick.ok = false;
			quickPick.placeholder = localize('choose account placeholder', "Select an account");
			quickPick.ignoreFocusOut = true;
			quickPick.items = this.createQuickpickItems();

			disposables.add(quickPick.onDidAccept(() => {
				result = quickPick.selectedItems[0]?.account ? quickPick.selectedItems[0]?.account : quickPick.selectedItems[0]?.authenticationProvider;
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				c(result);
			}));
			quickPick.show();
		});
	}

	private createQuickpickItems(): (AccountQuickPickItem | IQuickPickSeparator)[] {
		const quickPickItems: (AccountQuickPickItem | IQuickPickSeparator)[] = [];
		const authenticationProviders = [...this.authenticationProviders].sort(({ id }) => id === this.current?.providerId ? -1 : 1);
		for (const authenticationProvider of authenticationProviders) {
			const providerName = this.authenticationService.getDisplayName(authenticationProvider.id);
			quickPickItems.push({ type: 'separator', label: providerName });
			const accounts = this._all.get(authenticationProvider.id) || [];
			for (const account of accounts) {
				quickPickItems.push({
					label: account.accountName,
					detail: account.sessionId === this.current?.sessionId ? localize('last used', "Last Used") : undefined,
					account,
					authenticationProvider,
				});
			}
			quickPickItems.push({
				label: accounts.length ? localize('choose another', "Use another {0} Account", providerName) : localize('choose', "Use {0} Account", providerName),
				authenticationProvider,
			});
		}
		return quickPickItems;
	}

	private async switch(sessionId: string, accountName: string): Promise<void> {
		const currentAccount = this.current;
		if (this.userDataSyncEnablementService.isEnabled() && (currentAccount && currentAccount.accountName !== accountName)) {
			// accounts are switched while sync is enabled.
		}
		this.currentSessionId = sessionId;
		this.telemetryService.publicLog2<UserAccountEvent, UserAccountClassification>('sync.userAccount', { id: sessionId.split('/')[1] });
		await this.update();
	}

	private onDidChangeSessions(e: AuthenticationSessionsChangeEvent): void {
		if (this.currentSessionId && e.removed.includes(this.currentSessionId)) {
			this.currentSessionId = undefined;
		}
		this.update();
	}

	private onDidChangeStorage(e: IWorkspaceStorageChangeEvent): void {
		if (e.key === UserDataSyncAccounts.CACHED_SESSION_STORAGE_KEY && e.scope === StorageScope.GLOBAL
			&& this.currentSessionId !== this.getStoredCachedSessionId() /* This checks if current window changed the value or not */) {
			this._cachedCurrentSessionId = null;
			this.update();
		}
	}

	private _cachedCurrentSessionId: string | undefined | null = null;
	private get currentSessionId(): string | undefined {
		if (this._cachedCurrentSessionId === null) {
			this._cachedCurrentSessionId = this.getStoredCachedSessionId();
		}
		return this._cachedCurrentSessionId;
	}

	private set currentSessionId(cachedSessionId: string | undefined) {
		if (this.currentSessionId !== cachedSessionId) {
			this._cachedCurrentSessionId = cachedSessionId;
			if (cachedSessionId === undefined) {
				this.storageService.remove(UserDataSyncAccounts.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
			} else {
				this.storageService.store(UserDataSyncAccounts.CACHED_SESSION_STORAGE_KEY, cachedSessionId, StorageScope.GLOBAL);
			}
		}
	}

	private getStoredCachedSessionId(): string | undefined {
		return this.storageService.get(UserDataSyncAccounts.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
	}
}
