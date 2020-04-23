/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line code-import-patterns
import 'vs/css!vs/workbench/contrib/notebook/browser/media/notebook';
import { getZoomLevel } from 'vs/base/browser/browser';
import * as DOM from 'vs/base/browser/dom';
import { IListRenderer, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { ToolBar } from 'vs/base/browser/ui/toolbar/toolbar';
import { IAction, ActionRunner } from 'vs/base/common/actions';
import { Range } from 'vs/editor/common/core/range';
import { escape } from 'vs/base/common/strings';
import { DisposableStore } from 'vs/base/common/lifecycle';
import * as modes from 'vs/editor/common/modes';
import * as platform from 'vs/base/common/platform';
import { Color } from 'vs/base/common/color';
import { deepClone } from 'vs/base/common/objects';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import * as nls from 'vs/nls';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IEditorOptions, EditorOption, EDITOR_FONT_DEFAULTS } from 'vs/editor/common/config/editorOptions';
import { BareFontInfo } from 'vs/editor/common/config/fontInfo';
import { ContextAwareMenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenu, MenuItemAction } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { EDITOR_BOTTOM_PADDING, EDITOR_TOOLBAR_HEIGHT, EDITOR_TOP_MARGIN, EDITOR_TOP_PADDING, NOTEBOOK_CELL_EDITABLE_CONTEXT_KEY, NOTEBOOK_CELL_MARKDOWN_EDIT_MODE_CONTEXT_KEY, NOTEBOOK_CELL_TYPE_CONTEXT_KEY, NOTEBOOK_CELL_RUN_STATE_CONTEXT_KEY, NOTEBOOK_VIEW_TYPE, BOTTOM_CELL_TOOLBAR_HEIGHT } from 'vs/workbench/contrib/notebook/browser/constants';
import { ExecuteCellAction, INotebookCellActionContext, CancelCellAction, InsertCodeCellAction, InsertMarkdownCellAction } from 'vs/workbench/contrib/notebook/browser/contrib/notebookActions';
import { BaseCellRenderTemplate, CellEditState, CellRunState, CodeCellRenderTemplate, ICellViewModel, INotebookEditor, MarkdownCellRenderTemplate } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellMenus } from 'vs/workbench/contrib/notebook/browser/view/renderers/cellMenus';
import { CodeCell } from 'vs/workbench/contrib/notebook/browser/view/renderers/codeCell';
import { StatefullMarkdownCell } from 'vs/workbench/contrib/notebook/browser/view/renderers/markdownCell';
import { CodeCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/codeCellViewModel';
import { MarkdownCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/markdownCellViewModel';
import { CellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { CellKind, NotebookCellRunState } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { renderCodicons } from 'vs/base/common/codicons';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode } from 'vs/base/common/keyCodes';
import { domEvent } from 'vs/base/browser/event';
import { tokenizeLineToHTML } from 'vs/editor/common/modes/textToHtmlTokenizer';
import { ITextModel } from 'vs/editor/common/model';
import { BaseCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/baseCellViewModel';

const $ = DOM.$;

export class NotebookCellListDelegate implements IListVirtualDelegate<CellViewModel> {
	private _lineHeight: number;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		const editorOptions = this.configurationService.getValue<IEditorOptions>('editor');
		this._lineHeight = BareFontInfo.createFromRawSettings(editorOptions, getZoomLevel()).lineHeight;
	}

	getHeight(element: CellViewModel): number {
		return element.getHeight(this._lineHeight);
	}

	hasDynamicHeight(element: CellViewModel): boolean {
		return element.hasDynamicHeight();
	}

	getTemplateId(element: CellViewModel): string {
		if (element.cellKind === CellKind.Markdown) {
			return MarkdownCellRenderer.TEMPLATE_ID;
		} else {
			return CodeCellRenderer.TEMPLATE_ID;
		}
	}
}

export class CodiconActionViewItem extends ContextAwareMenuEntryActionViewItem {
	constructor(
		readonly _action: MenuItemAction,
		_keybindingService: IKeybindingService,
		_notificationService: INotificationService,
		_contextMenuService: IContextMenuService
	) {
		super(_action, _keybindingService, _notificationService, _contextMenuService);
	}
	updateLabel(): void {
		if (this.options.label && this.label) {
			this.label.innerHTML = renderCodicons(this._commandAction.label ?? '');
		}
	}
}

abstract class AbstractCellRenderer {
	protected editorOptions: IEditorOptions;
	private actionRunner = new ActionRunner();

	constructor(
		protected readonly instantiationService: IInstantiationService,
		protected readonly notebookEditor: INotebookEditor,
		protected readonly contextMenuService: IContextMenuService,
		private readonly configurationService: IConfigurationService,
		private readonly keybindingService: IKeybindingService,
		private readonly notificationService: INotificationService,
		protected readonly contextKeyService: IContextKeyService,
		language: string,
		protected readonly dndController: CellDragAndDropController
	) {
		const editorOptions = deepClone(this.configurationService.getValue<IEditorOptions>('editor', { overrideIdentifier: language }));
		this.editorOptions = {
			...editorOptions,
			padding: {
				top: EDITOR_TOP_PADDING,
				bottom: EDITOR_BOTTOM_PADDING
			},
			scrollBeyondLastLine: false,
			scrollbar: {
				verticalScrollbarSize: 14,
				horizontal: 'auto',
				useShadows: true,
				verticalHasArrows: false,
				horizontalHasArrows: false,
				alwaysConsumeMouseWheel: false
			},
			renderLineHighlightOnlyWhenFocus: true,
			overviewRulerLanes: 0,
			selectOnLineNumbers: false,
			lineNumbers: 'off',
			lineDecorationsWidth: 0,
			glyphMargin: false,
			fixedOverflowWidgets: false,
			minimap: { enabled: false },
		};
	}

	protected createBottomCellToolbar(container: HTMLElement): ToolBar {
		const toolbar = new ToolBar(container, this.contextMenuService, {
			actionViewItemProvider: action => {
				if (action instanceof MenuItemAction) {
					const item = new CodiconActionViewItem(action, this.keybindingService, this.notificationService, this.contextMenuService);
					return item;
				}

				return undefined;
			}
		});

		toolbar.getContainer().style.height = `${BOTTOM_CELL_TOOLBAR_HEIGHT}px`;
		return toolbar;
	}

	protected setupBetweenCellToolbarActions(element: CodeCellViewModel | MarkdownCellViewModel, templateData: BaseCellRenderTemplate, disposables: DisposableStore, context: INotebookCellActionContext): void {
		const container = templateData.bottomCellContainer;
		container.innerHTML = '';
		container.style.height = `${BOTTOM_CELL_TOOLBAR_HEIGHT}px`;

		DOM.append(container, $('.seperator'));
		const addCodeCell = DOM.append(container, $('span.button'));
		addCodeCell.innerHTML = renderCodicons(escape(`$(add) Code `));
		addCodeCell.tabIndex = 0;
		const insertCellBelow = this.instantiationService.createInstance(InsertCodeCellAction);

		disposables.add(DOM.addDisposableListener(addCodeCell, DOM.EventType.CLICK, () => {
			this.actionRunner.run(insertCellBelow, context);
		}));

		disposables.add((DOM.addDisposableListener(addCodeCell, DOM.EventType.KEY_DOWN, async e => {
			const event = new StandardKeyboardEvent(e);
			if ((event.equals(KeyCode.Enter) || event.equals(KeyCode.Space))) {
				e.preventDefault();
				e.stopPropagation();
				this.actionRunner.run(insertCellBelow, context);
			}
		})));

		DOM.append(container, $('.seperator-short'));
		const addMarkdownCell = DOM.append(container, $('span.button'));
		addMarkdownCell.innerHTML = renderCodicons(escape('$(add) Markdown '));
		addMarkdownCell.tabIndex = 0;
		const insertMarkdownBelow = this.instantiationService.createInstance(InsertMarkdownCellAction);
		disposables.add(DOM.addDisposableListener(addMarkdownCell, DOM.EventType.CLICK, () => {
			this.actionRunner.run(insertMarkdownBelow, context);
		}));

		disposables.add((DOM.addDisposableListener(addMarkdownCell, DOM.EventType.KEY_DOWN, async e => {
			const event = new StandardKeyboardEvent(e);
			if ((event.equals(KeyCode.Enter) || event.equals(KeyCode.Space))) {
				e.preventDefault();
				e.stopPropagation();
				this.actionRunner.run(insertMarkdownBelow, context);
			}
		})));

		DOM.append(container, $('.seperator'));

		if (element instanceof CodeCellViewModel) {
			const bottomToolbarOffset = element.layoutInfo.bottomToolbarOffset;
			container.style.top = `${bottomToolbarOffset}px`;

			disposables.add(element.onDidChangeLayout(() => {
				const bottomToolbarOffset = element.layoutInfo.bottomToolbarOffset;
				container.style.top = `${bottomToolbarOffset}px`;
			}));
		} else {
			container.style.position = 'static';
			container.style.height = '22px';
		}
	}

	protected createToolbar(container: HTMLElement): ToolBar {
		const toolbar = new ToolBar(container, this.contextMenuService, {
			actionViewItemProvider: action => {
				if (action instanceof MenuItemAction) {
					const item = new ContextAwareMenuEntryActionViewItem(action, this.keybindingService, this.notificationService, this.contextMenuService);
					return item;
				}

				return undefined;
			}
		});

		return toolbar;
	}

	private getCellToolbarActions(menu: IMenu): IAction[] {
		const actions: IAction[] = [];
		for (let [, menuActions] of menu.getActions({ shouldForwardArgs: true })) {
			actions.push(...menuActions);
		}

		return actions;
	}

	protected setupCellToolbarActions(scopedContextKeyService: IContextKeyService, templateData: BaseCellRenderTemplate, disposables: DisposableStore): void {
		const cellMenu = this.instantiationService.createInstance(CellMenus);
		const menu = disposables.add(cellMenu.getCellTitleMenu(scopedContextKeyService));

		const updateActions = () => {
			const actions = this.getCellToolbarActions(menu);

			templateData.toolbar.setActions(actions)();

			if (templateData.focusIndicator) {
				if (actions.length) {
					templateData.focusIndicator.style.top = `${EDITOR_TOOLBAR_HEIGHT + EDITOR_TOP_MARGIN}px`;
				} else {
					templateData.focusIndicator.style.top = `${EDITOR_TOP_MARGIN}px`;
				}
			}
		};

		updateActions();
		disposables.add(menu.onDidChange(() => {
			updateActions();
		}));
	}

	protected commonRenderElement(element: BaseCellViewModel, index: number, templateData: BaseCellRenderTemplate): void {
		if (element.dragging) {
			templateData.container.classList.add(DRAGGING_CLASS);
		} else {
			templateData.container.classList.remove(DRAGGING_CLASS);
		}
	}
}

export class MarkdownCellRenderer extends AbstractCellRenderer implements IListRenderer<MarkdownCellViewModel, MarkdownCellRenderTemplate> {
	static readonly TEMPLATE_ID = 'markdown_cell';
	private disposables: Map<ICellViewModel, DisposableStore> = new Map();

	constructor(
		contextKeyService: IContextKeyService,
		notehookEditor: INotebookEditor,
		dndController: CellDragAndDropController,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
	) {
		super(instantiationService, notehookEditor, contextMenuService, configurationService, keybindingService, notificationService, contextKeyService, 'markdown', dndController);
	}

	get templateId() {
		return MarkdownCellRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): MarkdownCellRenderTemplate {
		container.classList.add('markdown-cell-row');
		const disposables = new DisposableStore();
		const toolbar = disposables.add(this.createToolbar(container));

		const dragHandle = DOM.prepend(container, $('.cell-drag-handle'));
		dragHandle.innerHTML = renderCodicons('$(gripper)');
		dragHandle.setAttribute('draggable', 'true');

		const codeInnerContent = DOM.append(container, $('.cell.code'));
		const cellEditorPart = DOM.append(codeInnerContent, $('.cell-editor-part'));
		const editingContainer = DOM.append(cellEditorPart, $('.markdown-editor-container'));
		editingContainer.style.display = 'none';

		const innerContent = DOM.append(container, $('.cell.markdown'));
		const insertionIndicatorTop = DOM.append(container, DOM.$('.notebook-cell-insertion-indicator-top'));
		const focusIndicator = DOM.append(container, DOM.$('.notebook-cell-focus-indicator'));
		const foldingIndicator = DOM.append(container, DOM.$('.notebook-folding-indicator'));

		const bottomCellContainer = DOM.append(container, $('.cell-bottom-toolbar-container'));

		const templateData: MarkdownCellRenderTemplate = {
			insertionIndicatorTop,
			dragHandle,
			container,
			cellContainer: innerContent,
			editingContainer,
			focusIndicator,
			foldingIndicator,
			disposables,
			toolbar,
			bottomCellContainer,
			toJSON: () => { return {}; }
		};
		this.dndController.addListeners(templateData, () => this.getDragImage(templateData));
		return templateData;
	}

	private getDragImage(templateData: MarkdownCellRenderTemplate): HTMLElement {
		const dragImageContainer = DOM.$('.cell-drag-image.monaco-list-row.focused.markdown-cell-row');
		dragImageContainer.innerHTML = templateData.container.innerHTML;
		return dragImageContainer;
	}


	renderElement(element: MarkdownCellViewModel, index: number, templateData: MarkdownCellRenderTemplate, height: number | undefined): void {
		this.commonRenderElement(element, index, templateData);

		templateData.currentRenderedCell = element;
		templateData.editingContainer!.style.display = 'none';
		templateData.cellContainer.innerHTML = '';
		let renderedHTML = element.getHTML();
		if (renderedHTML) {
			templateData.cellContainer.appendChild(renderedHTML);
		}

		if (height) {
			this.disposables.get(element)?.clear();
			if (!this.disposables.has(element)) {
				this.disposables.set(element, new DisposableStore());
			}
			const elementDisposable = this.disposables.get(element)!;

			elementDisposable.add(new StatefullMarkdownCell(this.notebookEditor, element, templateData, this.editorOptions, this.instantiationService));

			const contextKeyService = this.contextKeyService.createScoped(templateData.container);
			contextKeyService.createKey(NOTEBOOK_CELL_TYPE_CONTEXT_KEY, 'markdown');
			contextKeyService.createKey(NOTEBOOK_VIEW_TYPE, element.viewType);

			const cellEditableKey = contextKeyService.createKey(NOTEBOOK_CELL_EDITABLE_CONTEXT_KEY, !!(element.metadata?.editable));
			const updateForMetadata = () => {
				const metadata = element.getEvaluatedMetadata(this.notebookEditor.viewModel!.notebookDocument.metadata);
				cellEditableKey.set(!!metadata.editable);
			};

			updateForMetadata();
			elementDisposable.add(element.onDidChangeState((e) => {
				if (e.metadataChanged) {
					updateForMetadata();
				}
			}));

			const editModeKey = contextKeyService.createKey(NOTEBOOK_CELL_MARKDOWN_EDIT_MODE_CONTEXT_KEY, element.editState === CellEditState.Editing);
			elementDisposable.add(element.onDidChangeState((e) => {
				if (e.editStateChanged) {
					editModeKey.set(element.editState === CellEditState.Editing);
				}
			}));

			this.setupCellToolbarActions(contextKeyService, templateData, elementDisposable);

			const toolbarContext = <INotebookCellActionContext>{
				cell: element,
				notebookEditor: this.notebookEditor,
				$mid: 12
			};
			templateData.toolbar.context = toolbarContext;

			this.setupBetweenCellToolbarActions(element, templateData, elementDisposable, toolbarContext);
			element.totalHeight = height;
		}

	}

	disposeTemplate(templateData: MarkdownCellRenderTemplate): void {
		templateData.disposables.clear();
	}

	disposeElement(element: ICellViewModel, index: number, templateData: MarkdownCellRenderTemplate, height: number | undefined): void {
		if (height) {
			this.disposables.get(element)?.clear();
		}
	}
}

const DRAGGING_CLASS = 'cell-dragging';
const DRAGOVER_CLASS = 'cell-dragover';

type DragImageProvider = () => HTMLElement;

export class CellDragAndDropController {
	// TODO roblou - should probably use dataTransfer here, but any dataTransfer set makes the editor think I am dropping a file, need
	// to figure out how to prevent that
	private currentDraggedCell: ICellViewModel | undefined;

	constructor(
		private readonly notebookEditor: INotebookEditor
	) { }

	addListeners(templateData: BaseCellRenderTemplate, dragImageProvider: DragImageProvider): void {
		const container = templateData.container;
		const dragHandle = templateData.dragHandle;

		const dragCleanup = () => {
			if (this.currentDraggedCell) {
				this.currentDraggedCell.dragging = false;
				this.currentDraggedCell = undefined;
			}
		};

		templateData.disposables.add(domEvent(dragHandle, DOM.EventType.DRAG_END)(() => {
			// TODO
			(this.notebookEditor.getInnerWebview() as any)!.element.style['pointer-events'] = '';

			// Note, templateData may have a different element rendered into it by now
			container.classList.remove(DRAGGING_CLASS);
			dragCleanup();
		}));

		templateData.disposables.add(domEvent(dragHandle, DOM.EventType.DRAG_START)(event => {
			(this.notebookEditor.getInnerWebview() as any)!.element.style['pointer-events'] = 'none';

			if (!event.dataTransfer) {
				return;
			}

			this.currentDraggedCell = templateData.currentRenderedCell!;
			this.currentDraggedCell.dragging = true;

			const dragImage = dragImageProvider();
			container.parentElement!.appendChild(dragImage);
			event.dataTransfer.setDragImage(dragImage, 0, 0);
			setTimeout(() => container.parentElement!.removeChild(dragImage!), 0); // Comment this out to debug drag image layout

			container.classList.add(DRAGGING_CLASS);
		}));

		templateData.disposables.add(domEvent(container, DOM.EventType.DRAG_OVER)(event => {
			event.preventDefault();
		}));

		templateData.disposables.add(domEvent(container, DOM.EventType.DROP)(event => {
			event.preventDefault();

			const draggedCell = this.currentDraggedCell!;
			dragCleanup();
			this.notebookEditor.moveCell(draggedCell, templateData.currentRenderedCell!, 'above');
			container.classList.remove(DRAGOVER_CLASS);
		}));

		templateData.disposables.add(domEvent(container, DOM.EventType.DRAG_ENTER)(event => {
			event.preventDefault();
			container.classList.add(DRAGOVER_CLASS);
		}));

		templateData.disposables.add(domEvent(container, DOM.EventType.DRAG_LEAVE)(event => {
			if (!event.relatedTarget || !DOM.isAncestor(event.relatedTarget as HTMLElement, container)) {
				container.classList.remove(DRAGOVER_CLASS);
			}
		}));
	}
}

class EditorTextRenderer {

	getRichText(editor: ICodeEditor, modelRange: Range): string | null {
		const model = editor.getModel();
		if (!model) {
			return null;
		}

		const colorMap = this._getDefaultColorMap();
		const fontInfo = editor.getOptions().get(EditorOption.fontInfo);
		const fontFamily = fontInfo.fontFamily === EDITOR_FONT_DEFAULTS.fontFamily ? fontInfo.fontFamily : `'${fontInfo.fontFamily}', ${EDITOR_FONT_DEFAULTS.fontFamily}`;

		return `<div style="`
			+ `color: ${colorMap[modes.ColorId.DefaultForeground]};`
			+ `background-color: ${colorMap[modes.ColorId.DefaultBackground]};`
			+ `font-family: ${fontFamily};`
			+ `font-weight: ${fontInfo.fontWeight};`
			+ `font-size: ${fontInfo.fontSize}px;`
			+ `line-height: ${fontInfo.lineHeight}px;`
			+ `white-space: pre;`
			+ `">`
			+ this._getRichTextLines(model, modelRange, colorMap)
			+ '</div>';
	}

	private _getRichTextLines(model: ITextModel, modelRange: Range, colorMap: string[]): string {
		const startLineNumber = modelRange.startLineNumber;
		const startColumn = modelRange.startColumn;
		const endLineNumber = modelRange.endLineNumber;
		const endColumn = modelRange.endColumn;

		const tabSize = model.getOptions().tabSize;

		let result = '';

		for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
			const lineTokens = model.getLineTokens(lineNumber);
			const lineContent = lineTokens.getLineContent();
			const startOffset = (lineNumber === startLineNumber ? startColumn - 1 : 0);
			const endOffset = (lineNumber === endLineNumber ? endColumn - 1 : lineContent.length);

			if (lineContent === '') {
				result += '<br>';
			} else {
				result += tokenizeLineToHTML(lineContent, lineTokens.inflate(), colorMap, startOffset, endOffset, tabSize, platform.isWindows);
			}
		}

		return result;
	}

	private _getDefaultColorMap(): string[] {
		let colorMap = modes.TokenizationRegistry.getColorMap();
		let result: string[] = ['#000000'];
		if (colorMap) {
			for (let i = 1, len = colorMap.length; i < len; i++) {
				result[i] = Color.Format.CSS.formatHex(colorMap[i]);
			}
		}
		return result;
	}
}

class CodeCellDragImageRenderer {
	getDragImage(templateData: CodeCellRenderTemplate): HTMLElement {
		let dragImage = this._getDragImage(templateData);
		if (!dragImage) {
			// TODO I don't think this can happen
			dragImage = document.createElement('div');
			dragImage.textContent = '1 cell';
		}

		return dragImage;
	}

	private _getDragImage(templateData: CodeCellRenderTemplate): HTMLElement | null {
		const dragImageContainer = DOM.$('.cell-drag-image.monaco-list-row.focused.code-cell-row');
		dragImageContainer.innerHTML = templateData.container.innerHTML;

		const editorContainer = dragImageContainer.querySelector('.cell-editor-container');
		if (!editorContainer) {
			return null;
		}

		const focusIndicator = dragImageContainer.querySelector('.notebook-cell-focus-indicator') as HTMLElement;
		if (focusIndicator) {
			focusIndicator.style.height = '40px';
		}

		const richEditorText = new EditorTextRenderer().getRichText(templateData.editor, new Range(1, 1, 1, 1000));
		if (!richEditorText) {
			return null;
		}

		editorContainer.innerHTML = richEditorText;

		return dragImageContainer;
	}
}

export class CodeCellRenderer extends AbstractCellRenderer implements IListRenderer<CodeCellViewModel, CodeCellRenderTemplate> {
	static readonly TEMPLATE_ID = 'code_cell';
	private disposables: Map<ICellViewModel, DisposableStore> = new Map();

	constructor(
		protected notebookEditor: INotebookEditor,
		protected contextKeyService: IContextKeyService,
		private renderedEditors: Map<ICellViewModel, ICodeEditor | undefined>,
		dndController: CellDragAndDropController,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
	) {
		super(instantiationService, notebookEditor, contextMenuService, configurationService, keybindingService, notificationService, contextKeyService, 'python', dndController);
	}

	get templateId() {
		return CodeCellRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): CodeCellRenderTemplate {
		container.classList.add('code-cell-row');
		const disposables = new DisposableStore();
		const toolbar = disposables.add(this.createToolbar(container));

		const cellContainer = DOM.append(container, $('.cell.code'));
		const runButtonContainer = DOM.append(cellContainer, $('.run-button-container'));
		const runToolbar = this.createToolbar(runButtonContainer);
		disposables.add(runToolbar);

		const dragHandle = DOM.prepend(container, $('.cell-drag-handle'));
		dragHandle.innerHTML = renderCodicons('$(gripper)');
		dragHandle.setAttribute('draggable', 'true');

		const executionOrderLabel = DOM.append(runButtonContainer, $('div.execution-count-label'));

		const editorPart = DOM.append(cellContainer, $('.cell-editor-part'));
		const editorContainer = DOM.append(editorPart, $('.cell-editor-container'));
		const editor = this.instantiationService.createInstance(CodeEditorWidget, editorContainer, {
			...this.editorOptions,
			dimension: {
				width: 0,
				height: 0
			}
		}, {});

		const progressBar = new ProgressBar(editorPart);
		progressBar.hide();
		disposables.add(progressBar);

		const statusBarContainer = DOM.append(editorPart, $('.cell-statusbar-container'));
		const cellRunStatusContainer = DOM.append(statusBarContainer, $('.cell-run-status'));
		const cellStatusMessageContainer = DOM.append(statusBarContainer, $('.cell-status-message'));
		const cellStatusPlaceholderContainer = DOM.append(statusBarContainer, $('.cell-status-placeholder'));

		const insertionIndicatorTop = DOM.append(container, DOM.$('.notebook-cell-insertion-indicator-top'));
		const focusIndicator = DOM.append(container, DOM.$('.notebook-cell-focus-indicator'));
		const outputContainer = DOM.append(container, $('.output'));
		const bottomCellContainer = DOM.append(container, $('.cell-bottom-toolbar-container'));

		const templateData: CodeCellRenderTemplate = {
			insertionIndicatorTop,
			dragHandle,
			container,
			cellContainer,
			statusBarContainer,
			cellRunStatusContainer,
			cellStatusMessageContainer,
			cellStatusPlaceholderContainer,
			progressBar,
			focusIndicator,
			toolbar,
			runToolbar,
			runButtonContainer,
			executionOrderLabel,
			outputContainer,
			editor,
			disposables,
			bottomCellContainer: bottomCellContainer,
			toJSON: () => { return {}; }
		};

		this.dndController.addListeners(templateData, () => new CodeCellDragImageRenderer().getDragImage(templateData));
		return templateData;
	}

	private updateForRunState(element: CodeCellViewModel, templateData: CodeCellRenderTemplate, runStateKey: IContextKey<string>): void {
		runStateKey.set(CellRunState[element.runState]);
		if (element.runState === CellRunState.Running) {
			templateData.progressBar.infinite().show(500);

			templateData.runToolbar.setActions([
				this.instantiationService.createInstance(CancelCellAction)
			])();
		} else {
			templateData.progressBar.hide();

			templateData.runToolbar.setActions([
				this.instantiationService.createInstance(ExecuteCellAction)
			])();
		}
	}

	private updateForMetadata(element: CodeCellViewModel, templateData: CodeCellRenderTemplate, cellEditableKey: IContextKey<boolean>): void {
		const metadata = element.getEvaluatedMetadata(this.notebookEditor.viewModel!.notebookDocument.metadata);
		DOM.toggleClass(templateData.cellContainer, 'runnable', !!metadata.runnable);
		this.renderExecutionOrder(element, templateData);
		cellEditableKey.set(!!metadata.editable);
		templateData.cellStatusMessageContainer.textContent = metadata?.statusMessage || '';

		if (metadata.runState === NotebookCellRunState.Success) {
			templateData.cellRunStatusContainer.innerHTML = renderCodicons('$(check)');
		} else if (metadata.runState === NotebookCellRunState.Error) {
			templateData.cellRunStatusContainer.innerHTML = renderCodicons('$(error)');
		} else if (metadata.runState === NotebookCellRunState.Running) {
			// TODO should extensions be able to customize the status message while running to show progress?
			templateData.cellStatusMessageContainer.textContent = nls.localize('cellRunningStatus', "Running");
			templateData.cellRunStatusContainer.innerHTML = renderCodicons('$(sync~spin)');
		} else {
			templateData.cellRunStatusContainer.innerHTML = '';
		}

		if (!metadata.statusMessage && (typeof metadata.runState === 'undefined' || metadata.runState === NotebookCellRunState.Idle)) {
			templateData.cellStatusPlaceholderContainer.textContent = 'Ctrl + Enter to run';
		} else {
			templateData.cellStatusPlaceholderContainer.textContent = '';
		}
	}

	private renderExecutionOrder(element: CodeCellViewModel, templateData: CodeCellRenderTemplate): void {
		const hasExecutionOrder = this.notebookEditor.viewModel!.notebookDocument.metadata?.hasExecutionOrder;
		if (hasExecutionOrder) {
			const executionOrdeerLabel = typeof element.metadata?.executionOrder === 'number' ? `[ ${element.metadata.executionOrder} ]` :
				'[   ]';
			templateData.executionOrderLabel.innerText = executionOrdeerLabel;
		} else {
			templateData.executionOrderLabel.innerText = '';
		}
	}

	renderElement(element: CodeCellViewModel, index: number, templateData: CodeCellRenderTemplate, height: number | undefined): void {
		this.commonRenderElement(element, index, templateData);

		templateData.currentRenderedCell = element;

		if (height === undefined) {
			return;
		}

		templateData.outputContainer.innerHTML = '';

		this.disposables.get(element)?.clear();
		if (!this.disposables.has(element)) {
			this.disposables.set(element, new DisposableStore());
		}

		const elementDisposable = this.disposables.get(element)!;

		elementDisposable.add(this.instantiationService.createInstance(CodeCell, this.notebookEditor, element, templateData));
		this.renderedEditors.set(element, templateData.editor);

		templateData.focusIndicator.style.height = `${element.layoutInfo.indicatorHeight}px`;
		elementDisposable.add(element.onDidChangeLayout(() => {
			templateData.focusIndicator.style.height = `${element.layoutInfo.indicatorHeight}px`;
		}));

		const contextKeyService = this.contextKeyService.createScoped(templateData.container);

		const runStateKey = contextKeyService.createKey(NOTEBOOK_CELL_RUN_STATE_CONTEXT_KEY, CellRunState[element.runState]);
		this.updateForRunState(element, templateData, runStateKey);
		elementDisposable.add(element.onDidChangeState((e) => {
			if (e.runStateChanged) {
				this.updateForRunState(element, templateData, runStateKey);
			}
		}));

		contextKeyService.createKey(NOTEBOOK_CELL_TYPE_CONTEXT_KEY, 'code');
		contextKeyService.createKey(NOTEBOOK_VIEW_TYPE, element.viewType);
		const cellEditableKey = contextKeyService.createKey(NOTEBOOK_CELL_EDITABLE_CONTEXT_KEY, !!(element.metadata?.editable));
		this.updateForMetadata(element, templateData, cellEditableKey);
		elementDisposable.add(element.onDidChangeState((e) => {
			if (e.metadataChanged) {
				this.updateForMetadata(element, templateData, cellEditableKey);
			}
		}));

		this.setupCellToolbarActions(contextKeyService, templateData, elementDisposable);

		const toolbarContext = <INotebookCellActionContext>{
			cell: element,
			cellTemplate: templateData,
			notebookEditor: this.notebookEditor,
			$mid: 12
		};
		templateData.toolbar.context = toolbarContext;
		templateData.runToolbar.context = toolbarContext;

		this.setupBetweenCellToolbarActions(element, templateData, elementDisposable, toolbarContext);
	}

	disposeTemplate(templateData: CodeCellRenderTemplate): void {
		templateData.disposables.clear();
	}

	disposeElement(element: ICellViewModel, index: number, templateData: CodeCellRenderTemplate, height: number | undefined): void {
		this.disposables.get(element)?.clear();
		this.renderedEditors.delete(element);
		templateData.focusIndicator.style.height = 'initial';
	}
}
