/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { getResizesObserver } from 'vs/workbench/contrib/notebook/browser/view/renderers/sizeObserver';
import { INotebookEditor, MarkdownCellRenderTemplate, CellFocusMode, CellEditState } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { raceCancellation } from 'vs/base/common/async';
import { MarkdownCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/markdownCellViewModel';
import { EDITOR_TOP_PADDING, EDITOR_BOTTOM_PADDING } from 'vs/workbench/contrib/notebook/browser/constants';
import { ITextModel } from 'vs/editor/common/model';
import { IDimension } from 'vs/base/browser/dom';

export class StatefullMarkdownCell extends Disposable {
	private editor: CodeEditorWidget | null = null;
	private cellContainer: HTMLElement;
	private editingContainer?: HTMLElement;

	private localDisposables: DisposableStore;

	constructor(
		private notebookEditor: INotebookEditor,
		private viewCell: MarkdownCellViewModel,
		private templateData: MarkdownCellRenderTemplate,
		editorOptions: IEditorOptions,
		instantiationService: IInstantiationService
	) {
		super();

		this.cellContainer = templateData.cellContainer;
		this.editingContainer = templateData.editingContainer;
		this.localDisposables = new DisposableStore();
		this._register(this.localDisposables);

		const viewUpdate = () => {
			if (viewCell.editState === CellEditState.Editing) {
				// switch to editing mode
				let width = viewCell.layoutInfo.editorWidth;
				const lineNum = viewCell.lineCount;
				const lineHeight = viewCell.layoutInfo.fontInfo?.lineHeight || 17;
				const totalHeight = Math.max(lineNum, 1) * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;

				if (this.editor) {
					// not first time, we don't need to create editor or bind listeners
					this.editingContainer!.style.display = 'flex';
					viewCell.attachTextEditor(this.editor!);
					if (notebookEditor.getActiveCell() === viewCell) {
						this.editor!.focus();
					}

					this.bindEditorListeners(this.editor!.getModel()!);
				} else {
					this.editingContainer!.style.display = 'flex';
					this.editingContainer!.innerHTML = '';
					this.editor = instantiationService.createInstance(CodeEditorWidget, this.editingContainer!, {
						...editorOptions,
						dimension: {
							width: width,
							height: totalHeight
						}
					}, {});

					const cts = new CancellationTokenSource();
					this._register({ dispose() { cts.dispose(true); } });
					raceCancellation(viewCell.resolveTextModel(), cts.token).then(model => {
						if (!model) {
							return;
						}

						this.editor!.setModel(model);
						if (notebookEditor.getActiveCell() === viewCell) {
							this.editor!.focus();
						}

						const realContentHeight = this.editor!.getContentHeight();
						if (realContentHeight !== totalHeight) {
							this.editor!.layout(
								{
									width: width,
									height: realContentHeight
								}
							);
						}

						viewCell.attachTextEditor(this.editor!);

						if (viewCell.editState === CellEditState.Editing) {
							this.editor!.focus();
						}

						this.bindEditorListeners(model, {
							width: width,
							height: totalHeight
						});
					});
				}

				const clientHeight = this.cellContainer.clientHeight;
				this.viewCell.totalHeight = totalHeight + 32 + clientHeight;
				notebookEditor.layoutNotebookCell(viewCell, totalHeight + 32 + clientHeight);
				this.editor.focus();
			} else {
				this.viewCell.detachTextEditor();
				if (this.editor) {
					// switch from editing mode
					this.editingContainer!.style.display = 'none';
					const clientHeight = templateData.container.clientHeight;
					this.viewCell.totalHeight = clientHeight;
					notebookEditor.layoutNotebookCell(viewCell, clientHeight);
				} else {
					// first time, readonly mode
					this.editingContainer!.style.display = 'none';

					this.cellContainer.innerHTML = '';
					let markdownRenderer = viewCell.getMarkdownRenderer();
					let renderedHTML = viewCell.getHTML();
					if (renderedHTML) {
						this.cellContainer.appendChild(renderedHTML);
					}

					this.localDisposables.add(markdownRenderer.onDidUpdateRender(() => {
						const clientHeight = templateData.container.clientHeight;
						this.viewCell.totalHeight = clientHeight;
						notebookEditor.layoutNotebookCell(viewCell, clientHeight);
					}));

					this.localDisposables.add(viewCell.onDidChangeContent(() => {
						this.cellContainer.innerHTML = '';
						let renderedHTML = viewCell.getHTML();
						if (renderedHTML) {
							this.cellContainer.appendChild(renderedHTML);
						}
					}));
				}
			}
		};

		this._register(viewCell.onDidChangeCellEditState(() => {
			this.localDisposables.clear();
			viewUpdate();
		}));

		this._register(viewCell.onDidChangeFocusMode(() => {
			if (viewCell.focusMode === CellFocusMode.Editor) {
				this.editor?.focus();
			}
		}));

		viewUpdate();
	}

	bindEditorListeners(model: ITextModel, dimension?: IDimension) {
		this.localDisposables.add(model.onDidChangeContent(() => {
			this.viewCell.setText(model.getLinesContent());
			let clientHeight = this.cellContainer.clientHeight;
			this.cellContainer.innerHTML = '';
			let renderedHTML = this.viewCell.getHTML();
			if (renderedHTML) {
				this.cellContainer.appendChild(renderedHTML);
				clientHeight = this.cellContainer.clientHeight;
			}

			this.viewCell.totalHeight = this.editor!.getContentHeight() + 32 + clientHeight;
			this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
		}));

		this.localDisposables.add(this.editor!.onDidContentSizeChange(e => {
			let viewLayout = this.editor!.getLayoutInfo();

			if (e.contentHeightChanged) {
				this.editor!.layout(
					{
						width: viewLayout.width,
						height: e.contentHeight
					}
				);
				const clientHeight = this.cellContainer.clientHeight;
				this.viewCell.totalHeight = e.contentHeight + 32 + clientHeight;
				this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
			}
		}));

		this.localDisposables.add(this.editor!.onDidChangeCursorSelection((e) => {
			if (e.source === 'restoreState') {
				// do not reveal the cell into view if this selection change was caused by restoring editors...
				return;
			}

			const primarySelection = this.editor!.getSelection();

			if (primarySelection) {
				this.notebookEditor.revealLineInView(this.viewCell, primarySelection!.positionLineNumber);
			}
		}));

		let cellWidthResizeObserver = getResizesObserver(this.templateData.editingContainer!, dimension, () => {
			let newWidth = cellWidthResizeObserver.getWidth();
			let realContentHeight = this.editor!.getContentHeight();
			let layoutInfo = this.editor!.getLayoutInfo();

			// the dimension generated by the resize observer are float numbers, let's round it a bit to avoid relayout.
			if (newWidth < layoutInfo.width - 0.3 || layoutInfo.width + 0.3 < newWidth) {
				this.editor!.layout(
					{
						width: newWidth,
						height: realContentHeight
					}
				);
			}
		});

		cellWidthResizeObserver.startObserving();
		this.localDisposables.add(cellWidthResizeObserver);

		let markdownRenderer = this.viewCell.getMarkdownRenderer();
		this.cellContainer.innerHTML = '';
		let renderedHTML = this.viewCell.getHTML();
		if (renderedHTML) {
			this.cellContainer.appendChild(renderedHTML);
			this.localDisposables.add(markdownRenderer.onDidUpdateRender(() => {
				const clientHeight = this.cellContainer.clientHeight;
				this.viewCell.totalHeight = clientHeight;
				this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
			}));
		}
	}

	dispose() {
		this.viewCell.detachTextEditor();
		super.dispose();
	}
}
