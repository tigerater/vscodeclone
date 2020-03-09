/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI, UriComponents } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import * as modes from 'vs/editor/common/modes';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { ILogService } from 'vs/platform/log/common/log';
import { IExtHostApiDeprecationService } from 'vs/workbench/api/common/extHostApiDeprecationService';
import { ExtHostDocuments } from 'vs/workbench/api/common/extHostDocuments';
import * as typeConverters from 'vs/workbench/api/common/extHostTypeConverters';
import { IExtHostWorkspace } from 'vs/workbench/api/common/extHostWorkspace';
import { EditorViewColumn } from 'vs/workbench/api/common/shared/editor';
import { asWebviewUri, WebviewInitData } from 'vs/workbench/api/common/shared/webview';
import type * as vscode from 'vscode';
import { ExtHostWebviewsShape, IMainContext, MainContext, MainThreadWebviewsShape, WebviewExtensionDescription, WebviewPanelHandle, WebviewPanelViewStateData } from './extHost.protocol';
import { Disposable as VSCodeDisposable } from './extHostTypes';

type IconPath = URI | { light: URI, dark: URI };

export class ExtHostWebview implements vscode.Webview {
	private _html: string = '';
	private _isDisposed: boolean = false;
	private _hasCalledAsWebviewUri = false;

	public readonly _onMessageEmitter = new Emitter<any>();
	public readonly onDidReceiveMessage: Event<any> = this._onMessageEmitter.event;

	constructor(
		private readonly _handle: WebviewPanelHandle,
		private readonly _proxy: MainThreadWebviewsShape,
		private _options: vscode.WebviewOptions,
		private readonly _initData: WebviewInitData,
		private readonly _workspace: IExtHostWorkspace | undefined,
		private readonly _extension: IExtensionDescription,
		private readonly _deprecationService: IExtHostApiDeprecationService,
	) { }

	public dispose() {
		this._onMessageEmitter.dispose();
	}

	public asWebviewUri(resource: vscode.Uri): vscode.Uri {
		this._hasCalledAsWebviewUri = true;
		return asWebviewUri(this._initData, this._handle, resource);
	}

	public get cspSource(): string {
		return this._initData.webviewCspSource
			.replace('{{uuid}}', this._handle);
	}

	public get html(): string {
		this.assertNotDisposed();
		return this._html;
	}

	public set html(value: string) {
		this.assertNotDisposed();
		if (this._html !== value) {
			this._html = value;
			if (!this._hasCalledAsWebviewUri && /(["'])vscode-resource:([^\s'"]+?)(["'])/i.test(value)) {
				this._hasCalledAsWebviewUri = true;
				this._deprecationService.report('Webview vscode-resource: uris', this._extension,
					`Please migrate to use the 'webview.asWebviewUri' api instead: https://aka.ms/vscode-webview-use-aswebviewuri`);
			}
			this._proxy.$setHtml(this._handle, value);
		}
	}

	public get options(): vscode.WebviewOptions {
		this.assertNotDisposed();
		return this._options;
	}

	public set options(newOptions: vscode.WebviewOptions) {
		this.assertNotDisposed();
		this._proxy.$setOptions(this._handle, convertWebviewOptions(this._extension, this._workspace, newOptions));
		this._options = newOptions;
	}

	public postMessage(message: any): Promise<boolean> {
		this.assertNotDisposed();
		return this._proxy.$postMessage(this._handle, message);
	}

	private assertNotDisposed() {
		if (this._isDisposed) {
			throw new Error('Webview is disposed');
		}
	}
}

export class ExtHostWebviewEditor extends Disposable implements vscode.WebviewPanel {

	private readonly _handle: WebviewPanelHandle;
	private readonly _proxy: MainThreadWebviewsShape;
	private readonly _viewType: string;
	private _title: string;
	private _iconPath?: IconPath;

	readonly #options: vscode.WebviewPanelOptions;
	readonly #webview: ExtHostWebview;

	#viewColumn: vscode.ViewColumn | undefined = undefined;
	#visible: boolean = true;
	#active: boolean = true;

	#isDisposed: boolean = false;

	readonly #onDidDispose = this._register(new Emitter<void>());
	public readonly onDidDispose = this.#onDidDispose.event;

	readonly #onDidChangeViewState = this._register(new Emitter<vscode.WebviewPanelOnDidChangeViewStateEvent>());
	public readonly onDidChangeViewState = this.#onDidChangeViewState.event;

	constructor(
		handle: WebviewPanelHandle,
		proxy: MainThreadWebviewsShape,
		viewType: string,
		title: string,
		viewColumn: vscode.ViewColumn | undefined,
		editorOptions: vscode.WebviewPanelOptions,
		webview: ExtHostWebview
	) {
		super();
		this._handle = handle;
		this._proxy = proxy;
		this._viewType = viewType;
		this.#options = editorOptions;
		this.#viewColumn = viewColumn;
		this._title = title;
		this.#webview = webview;
	}

	public dispose() {
		if (this.#isDisposed) {
			return;
		}

		this.#isDisposed = true;
		this.#onDidDispose.fire();
		this._proxy.$disposeWebview(this._handle);
		this.#webview.dispose();

		super.dispose();
	}

	get webview() {
		this.assertNotDisposed();
		return this.#webview;
	}

	get viewType(): string {
		this.assertNotDisposed();
		return this._viewType;
	}

	get title(): string {
		this.assertNotDisposed();
		return this._title;
	}

	set title(value: string) {
		this.assertNotDisposed();
		if (this._title !== value) {
			this._title = value;
			this._proxy.$setTitle(this._handle, value);
		}
	}

	get iconPath(): IconPath | undefined {
		this.assertNotDisposed();
		return this._iconPath;
	}

	set iconPath(value: IconPath | undefined) {
		this.assertNotDisposed();
		if (this._iconPath !== value) {
			this._iconPath = value;

			this._proxy.$setIconPath(this._handle, URI.isUri(value) ? { light: value, dark: value } : value);
		}
	}

	get options() {
		return this.#options;
	}

	get viewColumn(): vscode.ViewColumn | undefined {
		this.assertNotDisposed();
		if (typeof this.#viewColumn === 'number' && this.#viewColumn < 0) {
			// We are using a symbolic view column
			// Return undefined instead to indicate that the real view column is currently unknown but will be resolved.
			return undefined;
		}
		return this.#viewColumn;
	}

	public get active(): boolean {
		this.assertNotDisposed();
		return this.#active;
	}

	public get visible(): boolean {
		this.assertNotDisposed();
		return this.#visible;
	}

	_updateViewState(newState: { active: boolean; visible: boolean; viewColumn: vscode.ViewColumn; }) {
		if (this.#isDisposed) {
			return;
		}

		if (this.active !== newState.active || this.visible !== newState.visible || this.viewColumn !== newState.viewColumn) {
			this.#active = newState.active;
			this.#visible = newState.visible;
			this.#viewColumn = newState.viewColumn;
			this.#onDidChangeViewState.fire({ webviewPanel: this });
		}
	}

	public postMessage(message: any): Promise<boolean> {
		this.assertNotDisposed();
		return this._proxy.$postMessage(this._handle, message);
	}

	public reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void {
		this.assertNotDisposed();
		this._proxy.$reveal(this._handle, {
			viewColumn: viewColumn ? typeConverters.ViewColumn.from(viewColumn) : undefined,
			preserveFocus: !!preserveFocus
		});
	}

	private assertNotDisposed() {
		if (this.#isDisposed) {
			throw new Error('Webview is disposed');
		}
	}
}

type EditType = unknown;

class CustomDocument extends Disposable implements vscode.CustomDocument {

	public static create(proxy: MainThreadWebviewsShape, viewType: string, uri: vscode.Uri) {
		return Object.seal(new CustomDocument(proxy, viewType, uri));
	}

	// Explicitly initialize all properties as we seal the object after creation!

	#currentEditIndex: number = -1;
	#savePoint: number = -1;
	readonly #edits: Array<EditType> = [];

	readonly #proxy: MainThreadWebviewsShape;
	readonly #viewType: string;
	readonly #uri: vscode.Uri;

	#capabilities: vscode.CustomEditorCapabilities | undefined = undefined;

	private constructor(proxy: MainThreadWebviewsShape, viewType: string, uri: vscode.Uri) {
		super();
		this.#proxy = proxy;
		this.#viewType = viewType;
		this.#uri = uri;
	}

	dispose() {
		this.#onDidDispose.fire();
		super.dispose();
	}

	//#region Public API

	public get viewType(): string { return this.#viewType; }

	public get uri(): vscode.Uri { return this.#uri; }

	#onDidDispose = this._register(new Emitter<void>());
	public readonly onDidDispose = this.#onDidDispose.event;

	public userData: unknown = undefined;

	//#endregion

	//#region Internal

	/** @internal*/ _setCapabilities(capabilities: vscode.CustomEditorCapabilities) {
		if (this.#capabilities) {
			throw new Error('Capabilities already provided');
		}

		this.#capabilities = capabilities;
		capabilities.editing?.onDidEdit(edit => {
			this.pushEdit(edit);
		});
	}

	/** @internal*/ _revert() {
		const editing = this.getEditingCapability();
		if (this.#currentEditIndex === this.#savePoint) {
			return true;
		}

		if (this.#currentEditIndex >= this.#savePoint) {
			const editsToUndo = this.#edits.slice(this.#savePoint, this.#currentEditIndex);
			editing.undoEdits(editsToUndo.reverse());
		} else if (this.#currentEditIndex < this.#savePoint) {
			const editsToRedo = this.#edits.slice(this.#currentEditIndex, this.#savePoint);
			editing.applyEdits(editsToRedo);
		}

		this.#currentEditIndex = this.#savePoint;
		this.spliceEdits();

		this.updateState();
		return true;
	}

	/** @internal*/ _undo() {
		const editing = this.getEditingCapability();
		if (this.#currentEditIndex < 0) {
			// nothing to undo
			return;
		}

		const undoneEdit = this.#edits[this.#currentEditIndex];
		--this.#currentEditIndex;
		editing.undoEdits([undoneEdit]);
		this.updateState();
	}

	/** @internal*/ _redo() {
		const editing = this.getEditingCapability();
		if (this.#currentEditIndex >= this.#edits.length - 1) {
			// nothing to redo
			return;
		}

		++this.#currentEditIndex;
		const redoneEdit = this.#edits[this.#currentEditIndex];
		editing.applyEdits([redoneEdit]);
		this.updateState();
	}

	/** @internal*/ _save(cancellation: CancellationToken) {
		return this.getEditingCapability().save(cancellation);
	}

	/** @internal*/ _saveAs(target: vscode.Uri) {
		return this.getEditingCapability().saveAs(target);
	}

	/** @internal*/ _backup(cancellation: CancellationToken) {
		return this.getEditingCapability().backup(cancellation);
	}

	//#endregion

	private pushEdit(edit: EditType) {
		this.spliceEdits(edit);

		this.#currentEditIndex = this.#edits.length - 1;
		this.updateState();
	}

	private updateState() {
		const dirty = this.#edits.length > 0 && this.#savePoint !== this.#currentEditIndex;
		this.#proxy.$onDidChangeCustomDocumentState(this.uri, this.viewType, { dirty });
	}

	private spliceEdits(editToInsert?: EditType) {
		const start = this.#currentEditIndex + 1;
		const toRemove = this.#edits.length - this.#currentEditIndex;

		editToInsert
			? this.#edits.splice(start, toRemove, editToInsert)
			: this.#edits.splice(start, toRemove);
	}

	private getEditingCapability(): vscode.CustomEditorEditingCapability {
		if (!this.#capabilities?.editing) {
			throw new Error('Document is not editable');
		}
		return this.#capabilities.editing;
	}
}

class WebviewDocumentStore {
	private readonly _documents = new Map<string, CustomDocument>();

	public get(viewType: string, resource: vscode.Uri): CustomDocument | undefined {
		return this._documents.get(this.key(viewType, resource));
	}

	public add(document: CustomDocument) {
		const key = this.key(document.viewType, document.uri);
		if (this._documents.has(key)) {
			throw new Error(`Document already exists for viewType:${document.viewType} resource:${document.uri}`);
		}
		this._documents.set(key, document);
	}

	public delete(document: CustomDocument) {
		const key = this.key(document.viewType, document.uri);
		this._documents.delete(key);
	}

	private key(viewType: string, resource: vscode.Uri): string {
		return `${viewType}@@@${resource}`;
	}
}

const enum WebviewEditorType {
	Text,
	Custom
}

type ProviderEntry = {
	readonly extension: IExtensionDescription;
	readonly type: WebviewEditorType.Text;
	readonly provider: vscode.CustomTextEditorProvider;
} | {
	readonly extension: IExtensionDescription;
	readonly type: WebviewEditorType.Custom;
	readonly provider: vscode.CustomEditorProvider;
};

class EditorProviderStore {
	private readonly _providers = new Map<string, ProviderEntry>();

	public addTextProvider(viewType: string, extension: IExtensionDescription, provider: vscode.CustomTextEditorProvider): vscode.Disposable {
		return this.add(WebviewEditorType.Text, viewType, extension, provider);
	}

	public addCustomProvider(viewType: string, extension: IExtensionDescription, provider: vscode.CustomEditorProvider): vscode.Disposable {
		return this.add(WebviewEditorType.Custom, viewType, extension, provider);
	}

	public get(viewType: string): ProviderEntry | undefined {
		return this._providers.get(viewType);
	}

	private add(type: WebviewEditorType, viewType: string, extension: IExtensionDescription, provider: vscode.CustomTextEditorProvider | vscode.CustomEditorProvider): vscode.Disposable {
		if (this._providers.has(viewType)) {
			throw new Error(`Provider for viewType:${viewType} already registered`);
		}
		this._providers.set(viewType, { type, extension, provider } as ProviderEntry);
		return new VSCodeDisposable(() => this._providers.delete(viewType));
	}
}

export class ExtHostWebviews implements ExtHostWebviewsShape {

	private static newHandle(): WebviewPanelHandle {
		return generateUuid();
	}

	private readonly _proxy: MainThreadWebviewsShape;
	private readonly _webviewPanels = new Map<WebviewPanelHandle, ExtHostWebviewEditor>();

	private readonly _serializers = new Map<string, {
		readonly serializer: vscode.WebviewPanelSerializer;
		readonly extension: IExtensionDescription;
	}>();

	private readonly _editorProviders = new EditorProviderStore();

	private readonly _documents = new WebviewDocumentStore();

	constructor(
		mainContext: IMainContext,
		private readonly initData: WebviewInitData,
		private readonly workspace: IExtHostWorkspace | undefined,
		private readonly _logService: ILogService,
		private readonly _deprecationService: IExtHostApiDeprecationService,
		private readonly _extHostDocuments: ExtHostDocuments,
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadWebviews);
	}

	public createWebviewPanel(
		extension: IExtensionDescription,
		viewType: string,
		title: string,
		showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn, preserveFocus?: boolean },
		options: (vscode.WebviewPanelOptions & vscode.WebviewOptions) = {},
	): vscode.WebviewPanel {
		const viewColumn = typeof showOptions === 'object' ? showOptions.viewColumn : showOptions;
		const webviewShowOptions = {
			viewColumn: typeConverters.ViewColumn.from(viewColumn),
			preserveFocus: typeof showOptions === 'object' && !!showOptions.preserveFocus
		};

		const handle = ExtHostWebviews.newHandle();
		this._proxy.$createWebviewPanel(toExtensionData(extension), handle, viewType, title, webviewShowOptions, convertWebviewOptions(extension, this.workspace, options));

		const webview = new ExtHostWebview(handle, this._proxy, options, this.initData, this.workspace, extension, this._deprecationService);
		const panel = new ExtHostWebviewEditor(handle, this._proxy, viewType, title, viewColumn, options, webview);
		this._webviewPanels.set(handle, panel);
		return panel;
	}

	public registerWebviewPanelSerializer(
		extension: IExtensionDescription,
		viewType: string,
		serializer: vscode.WebviewPanelSerializer
	): vscode.Disposable {
		if (this._serializers.has(viewType)) {
			throw new Error(`Serializer for '${viewType}' already registered`);
		}

		this._serializers.set(viewType, { serializer, extension });
		this._proxy.$registerSerializer(viewType);

		return new VSCodeDisposable(() => {
			this._serializers.delete(viewType);
			this._proxy.$unregisterSerializer(viewType);
		});
	}

	public registerCustomEditorProvider(
		extension: IExtensionDescription,
		viewType: string,
		provider: vscode.CustomEditorProvider | vscode.CustomTextEditorProvider,
		options: vscode.WebviewPanelOptions | undefined = {}
	): vscode.Disposable {
		let disposable: vscode.Disposable;
		if ('resolveCustomTextEditor' in provider) {
			disposable = this._editorProviders.addTextProvider(viewType, extension, provider);
			this._proxy.$registerTextEditorProvider(toExtensionData(extension), viewType, options);
		} else {
			disposable = this._editorProviders.addCustomProvider(viewType, extension, provider);
			this._proxy.$registerCustomEditorProvider(toExtensionData(extension), viewType, options);
		}

		return VSCodeDisposable.from(
			disposable,
			new VSCodeDisposable(() => {
				this._proxy.$unregisterEditorProvider(viewType);
			}));
	}

	public $onMessage(
		handle: WebviewPanelHandle,
		message: any
	): void {
		const panel = this.getWebviewPanel(handle);
		if (panel) {
			panel.webview._onMessageEmitter.fire(message);
		}
	}

	public $onMissingCsp(
		_handle: WebviewPanelHandle,
		extensionId: string
	): void {
		this._logService.warn(`${extensionId} created a webview without a content security policy: https://aka.ms/vscode-webview-missing-csp`);
	}

	public $onDidChangeWebviewPanelViewStates(newStates: WebviewPanelViewStateData): void {
		const handles = Object.keys(newStates);
		// Notify webviews of state changes in the following order:
		// - Non-visible
		// - Visible
		// - Active
		handles.sort((a, b) => {
			const stateA = newStates[a];
			const stateB = newStates[b];
			if (stateA.active) {
				return 1;
			}
			if (stateB.active) {
				return -1;
			}
			return (+stateA.visible) - (+stateB.visible);
		});

		for (const handle of handles) {
			const panel = this.getWebviewPanel(handle);
			if (!panel) {
				continue;
			}

			const newState = newStates[handle];
			panel._updateViewState({
				active: newState.active,
				visible: newState.visible,
				viewColumn: typeConverters.ViewColumn.to(newState.position),
			});
		}
	}

	async $onDidDisposeWebviewPanel(handle: WebviewPanelHandle): Promise<void> {
		const panel = this.getWebviewPanel(handle);
		if (panel) {
			panel.dispose();
			this._webviewPanels.delete(handle);
		}
	}

	async $deserializeWebviewPanel(
		webviewHandle: WebviewPanelHandle,
		viewType: string,
		title: string,
		state: any,
		position: EditorViewColumn,
		options: modes.IWebviewOptions & modes.IWebviewPanelOptions
	): Promise<void> {
		const entry = this._serializers.get(viewType);
		if (!entry) {
			throw new Error(`No serializer found for '${viewType}'`);
		}
		const { serializer, extension } = entry;

		const webview = new ExtHostWebview(webviewHandle, this._proxy, options, this.initData, this.workspace, extension, this._deprecationService);
		const revivedPanel = new ExtHostWebviewEditor(webviewHandle, this._proxy, viewType, title, typeof position === 'number' && position >= 0 ? typeConverters.ViewColumn.to(position) : undefined, options, webview);
		this._webviewPanels.set(webviewHandle, revivedPanel);
		await serializer.deserializeWebviewPanel(revivedPanel, state);
	}

	async $createWebviewCustomEditorDocument(resource: UriComponents, viewType: string) {
		const entry = this._editorProviders.get(viewType);
		if (!entry) {
			throw new Error(`No provider found for '${viewType}'`);
		}

		if (entry.type !== WebviewEditorType.Custom) {
			throw new Error(`Invalid provide type for '${viewType}'`);
		}

		const revivedResource = URI.revive(resource);
		const document = CustomDocument.create(this._proxy, viewType, revivedResource);
		const capabilities = await entry.provider.resolveCustomDocument(document);
		document._setCapabilities(capabilities);
		this._documents.add(document);
		return {
			editable: !!capabilities.editing
		};
	}

	async $disposeWebviewCustomEditorDocument(resource: UriComponents, viewType: string): Promise<void> {
		const entry = this._editorProviders.get(viewType);
		if (!entry) {
			throw new Error(`No provider found for '${viewType}'`);
		}

		if (entry.type !== WebviewEditorType.Custom) {
			throw new Error(`Invalid provider type for '${viewType}'`);
		}

		const revivedResource = URI.revive(resource);
		const document = this.getCustomDocument(viewType, revivedResource);
		this._documents.delete(document);
		document.dispose();
	}

	async $resolveWebviewEditor(
		resource: UriComponents,
		handle: WebviewPanelHandle,
		viewType: string,
		title: string,
		position: EditorViewColumn,
		options: modes.IWebviewOptions & modes.IWebviewPanelOptions
	): Promise<void> {
		const entry = this._editorProviders.get(viewType);
		if (!entry) {
			throw new Error(`No provider found for '${viewType}'`);
		}

		const webview = new ExtHostWebview(handle, this._proxy, options, this.initData, this.workspace, entry.extension, this._deprecationService);
		const revivedPanel = new ExtHostWebviewEditor(handle, this._proxy, viewType, title, typeof position === 'number' && position >= 0 ? typeConverters.ViewColumn.to(position) : undefined, options, webview);
		this._webviewPanels.set(handle, revivedPanel);

		const revivedResource = URI.revive(resource);

		switch (entry.type) {
			case WebviewEditorType.Custom:
				{
					const document = this.getCustomDocument(viewType, revivedResource);
					return entry.provider.resolveCustomEditor(document, revivedPanel);
				}
			case WebviewEditorType.Text:
				{
					const document = this._extHostDocuments.getDocument(revivedResource);
					return entry.provider.resolveCustomTextEditor(document, revivedPanel);
				}
			default:
				{
					throw new Error('Unknown webview provider type');
				}
		}
	}

	async $undo(resourceComponents: UriComponents, viewType: string): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		document._undo();
	}

	async $redo(resourceComponents: UriComponents, viewType: string): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		document._redo();
	}

	async $revert(resourceComponents: UriComponents, viewType: string): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		document._revert();
	}

	async $onSave(resourceComponents: UriComponents, viewType: string, cancellation: CancellationToken): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		document._save(cancellation);
	}

	async $onSaveAs(resourceComponents: UriComponents, viewType: string, targetResource: UriComponents): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		return document._saveAs(URI.revive(targetResource));
	}

	async $backup(resourceComponents: UriComponents, viewType: string, cancellation: CancellationToken): Promise<void> {
		const document = this.getCustomDocument(viewType, resourceComponents);
		return document._backup(cancellation);
	}

	private getWebviewPanel(handle: WebviewPanelHandle): ExtHostWebviewEditor | undefined {
		return this._webviewPanels.get(handle);
	}

	private getCustomDocument(viewType: string, resource: UriComponents): CustomDocument {
		const document = this._documents.get(viewType, URI.revive(resource));
		if (!document) {
			throw new Error('No webview editor custom document found');
		}
		return document;
	}
}

function toExtensionData(extension: IExtensionDescription): WebviewExtensionDescription {
	return { id: extension.identifier, location: extension.extensionLocation };
}

function convertWebviewOptions(
	extension: IExtensionDescription,
	workspace: IExtHostWorkspace | undefined,
	options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
): modes.IWebviewOptions {
	return {
		...options,
		localResourceRoots: options.localResourceRoots || getDefaultLocalResourceRoots(extension, workspace)
	};
}

function getDefaultLocalResourceRoots(
	extension: IExtensionDescription,
	workspace: IExtHostWorkspace | undefined,
): URI[] {
	return [
		...(workspace?.getWorkspaceFolders() || []).map(x => x.uri),
		extension.extensionLocation,
	];
}
