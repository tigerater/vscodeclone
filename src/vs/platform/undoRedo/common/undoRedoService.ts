/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IUndoRedoService, IResourceUndoRedoElement, IWorkspaceUndoRedoElement, UndoRedoElementType } from 'vs/platform/undoRedo/common/undoRedo';
import { URI } from 'vs/base/common/uri';
import { getComparisonKey as uriGetComparisonKey } from 'vs/base/common/resources';
import { onUnexpectedError } from 'vs/base/common/errors';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import Severity from 'vs/base/common/severity';
import { Schemas } from 'vs/base/common/network';
import { INotificationService } from 'vs/platform/notification/common/notification';

class ResourceStackElement {
	public readonly type = UndoRedoElementType.Resource;
	public readonly actual: IResourceUndoRedoElement;
	public readonly label: string;

	public readonly resource: URI;
	public readonly strResource: string;
	public readonly resources: URI[];
	public readonly strResources: string[];

	constructor(actual: IResourceUndoRedoElement) {
		this.actual = actual;
		this.label = actual.label;
		this.resource = actual.resource;
		this.strResource = uriGetComparisonKey(this.resource);
		this.resources = [this.resource];
		this.strResources = [this.strResource];
	}
}

const enum RemovedResourceReason {
	ExternalRemoval = 0,
	NoParallelUniverses = 1
}

class RemovedResources {
	public readonly set: Set<string> = new Set<string>();
	public readonly reason: [URI[], URI[]] = [[], []];

	public createMessage(): string {
		let messages: string[] = [];
		if (this.reason[RemovedResourceReason.ExternalRemoval].length > 0) {
			const paths = this.reason[RemovedResourceReason.ExternalRemoval].map(uri => uri.scheme === Schemas.file ? uri.fsPath : uri.path);
			messages.push(nls.localize('externalRemoval', "The following files have been closed: {0}.", paths.join(', ')));
		}
		if (this.reason[RemovedResourceReason.NoParallelUniverses].length > 0) {
			const paths = this.reason[RemovedResourceReason.NoParallelUniverses].map(uri => uri.scheme === Schemas.file ? uri.fsPath : uri.path);
			messages.push(nls.localize('noParallelUniverses', "The following files have been modified in an incompatible way: {0}.", paths.join(', ')));
		}
		return messages.join('\n');
	}
}

class WorkspaceStackElement {
	public readonly type = UndoRedoElementType.Workspace;
	public readonly actual: IWorkspaceUndoRedoElement;
	public readonly label: string;

	public readonly resources: URI[];
	public readonly strResources: string[];
	public removedResources: RemovedResources | null;

	constructor(actual: IWorkspaceUndoRedoElement) {
		this.actual = actual;
		this.label = actual.label;
		this.resources = actual.resources.slice(0);
		this.strResources = this.resources.map(resource => uriGetComparisonKey(resource));
		this.removedResources = null;
	}

	public removeResource(resource: URI, strResource: string, reason: RemovedResourceReason): void {
		if (!this.removedResources) {
			this.removedResources = new RemovedResources();
		}
		if (!this.removedResources.set.has(strResource)) {
			this.removedResources.set.add(strResource);
			this.removedResources.reason[reason].push(resource);
		}
	}
}
type StackElement = ResourceStackElement | WorkspaceStackElement;

class ResourceEditStack {
	public resource: URI;
	public past: StackElement[];
	public future: StackElement[];

	constructor(resource: URI) {
		this.resource = resource;
		this.past = [];
		this.future = [];
	}
}

export class UndoRedoService implements IUndoRedoService {
	_serviceBrand: undefined;

	private readonly _editStacks: Map<string, ResourceEditStack>;

	constructor(
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		this._editStacks = new Map<string, ResourceEditStack>();
	}

	public pushElement(_element: IResourceUndoRedoElement | IWorkspaceUndoRedoElement): void {
		const element: StackElement = (_element.type === UndoRedoElementType.Resource ? new ResourceStackElement(_element) : new WorkspaceStackElement(_element));
		for (let i = 0, len = element.resources.length; i < len; i++) {
			const resource = element.resources[i];
			const strResource = element.strResources[i];

			let editStack: ResourceEditStack;
			if (this._editStacks.has(strResource)) {
				editStack = this._editStacks.get(strResource)!;
			} else {
				editStack = new ResourceEditStack(resource);
				this._editStacks.set(strResource, editStack);
			}

			// remove the future
			for (const futureElement of editStack.future) {
				if (futureElement.type === UndoRedoElementType.Workspace) {
					futureElement.removeResource(resource, strResource, RemovedResourceReason.NoParallelUniverses);
				}
			}
			editStack.future = [];
			editStack.past.push(element);
		}
	}

	public getLastElement(resource: URI): IResourceUndoRedoElement | IWorkspaceUndoRedoElement | null {
		const strResource = uriGetComparisonKey(resource);
		if (this._editStacks.has(strResource)) {
			const editStack = this._editStacks.get(strResource)!;
			if (editStack.future.length > 0) {
				return null;
			}
			if (editStack.past.length === 0) {
				return null;
			}
			return editStack.past[editStack.past.length - 1].actual;
		}
		return null;
	}

	private _splitPastWorkspaceElement(toRemove: WorkspaceStackElement, ignoreResources: Set<string> | null): void {
		const individualArr = toRemove.actual.split();
		const individualMap = new Map<string, ResourceStackElement>();
		for (const _element of individualArr) {
			const element = new ResourceStackElement(_element);
			individualMap.set(element.strResource, element);
		}

		for (const strResource of toRemove.strResources) {
			if (ignoreResources && ignoreResources.has(strResource)) {
				continue;
			}
			const editStack = this._editStacks.get(strResource)!;
			for (let j = editStack.past.length - 1; j >= 0; j--) {
				if (editStack.past[j] === toRemove) {
					if (individualMap.has(strResource)) {
						// gets replaced
						editStack.past[j] = individualMap.get(strResource)!;
					} else {
						// gets deleted
						editStack.past.splice(j, 1);
					}
					break;
				}
			}
		}
	}

	private _splitFutureWorkspaceElement(toRemove: WorkspaceStackElement, ignoreResources: Set<string> | null): void {
		const individualArr = toRemove.actual.split();
		const individualMap = new Map<string, ResourceStackElement>();
		for (const _element of individualArr) {
			const element = new ResourceStackElement(_element);
			individualMap.set(element.strResource, element);
		}

		for (const strResource of toRemove.strResources) {
			if (ignoreResources && ignoreResources.has(strResource)) {
				continue;
			}
			const editStack = this._editStacks.get(strResource)!;
			for (let j = editStack.future.length - 1; j >= 0; j--) {
				if (editStack.future[j] === toRemove) {
					if (individualMap.has(strResource)) {
						// gets replaced
						editStack.future[j] = individualMap.get(strResource)!;
					} else {
						// gets deleted
						editStack.future.splice(j, 1);
					}
					break;
				}
			}
		}
	}

	public removeElements(resource: URI): void {
		const strResource = uriGetComparisonKey(resource);
		if (this._editStacks.has(strResource)) {
			const editStack = this._editStacks.get(strResource)!;
			for (const element of editStack.past) {
				if (element.type === UndoRedoElementType.Workspace) {
					element.removeResource(resource, strResource, RemovedResourceReason.ExternalRemoval);
				}
			}
			for (const element of editStack.future) {
				if (element.type === UndoRedoElementType.Workspace) {
					element.removeResource(resource, strResource, RemovedResourceReason.ExternalRemoval);
				}
			}
			this._editStacks.delete(strResource);
		}
	}

	public canUndo(resource: URI): boolean {
		const strResource = uriGetComparisonKey(resource);
		if (this._editStacks.has(strResource)) {
			const editStack = this._editStacks.get(strResource)!;
			return (editStack.past.length > 0);
		}
		return false;
	}

	private _onError(err: Error, element: StackElement): void {
		onUnexpectedError(err);
		// An error occured while undoing or redoing => drop the undo/redo stack for all affected resources
		for (const resource of element.resources) {
			this.removeElements(resource);
		}
		this._notificationService.error(err);
	}

	private _safeInvoke(element: StackElement, invoke: () => Promise<void> | void): Promise<void> | void {
		let result: Promise<void> | void;
		try {
			result = invoke();
		} catch (err) {
			return this._onError(err, element);
		}

		if (result) {
			return result.then(undefined, (err) => this._onError(err, element));
		}
	}

	private _workspaceUndo(resource: URI, element: WorkspaceStackElement): Promise<void> | void {
		if (element.removedResources) {
			this._splitPastWorkspaceElement(element, element.removedResources.set);
			const message = nls.localize('cannotWorkspaceUndo', "Could not undo '{0}' across all files. {1}", element.label, element.removedResources.createMessage());
			this._notificationService.info(message);
			return;
		}

		// this must be the last past element in all the impacted resources!
		let affectedEditStacks: ResourceEditStack[] = [];
		for (const strResource of element.strResources) {
			affectedEditStacks.push(this._editStacks.get(strResource)!);
		}

		let cannotUndoDueToResources: URI[] = [];
		for (const editStack of affectedEditStacks) {
			if (editStack.past.length === 0 || editStack.past[editStack.past.length - 1] !== element) {
				cannotUndoDueToResources.push(editStack.resource);
			}
		}

		if (cannotUndoDueToResources.length > 0) {
			this._splitPastWorkspaceElement(element, null);
			const paths = cannotUndoDueToResources.map(r => r.scheme === Schemas.file ? r.fsPath : r.path);
			const message = nls.localize('cannotWorkspaceUndoDueToChanges', "Could not undo '{0}' across all files because changes were made to {1}", element.label, paths.join(', '));
			this._notificationService.info(message);
			return;
		}

		return this._dialogService.show(
			Severity.Info,
			nls.localize('confirmWorkspace', "Would you like to undo '{0}' across all files?", element.label),
			[
				nls.localize('ok', "Yes, change {0} files.", affectedEditStacks.length),
				nls.localize('nok', "No, change only this file.")
			]
		).then((result) => {
			if (result.choice === 0) {
				for (const editStack of affectedEditStacks) {
					editStack.past.pop();
					editStack.future.push(element);
				}
				return this._safeInvoke(element, () => element.actual.undo());
			} else {
				this._splitPastWorkspaceElement(element, null);
				return this.undo(resource);
			}
		});
	}

	private _resourceUndo(editStack: ResourceEditStack, element: ResourceStackElement): Promise<void> | void {
		editStack.past.pop();
		editStack.future.push(element);
		return this._safeInvoke(element, () => element.actual.undo());
	}

	public undo(resource: URI): Promise<void> | void {
		const strResource = uriGetComparisonKey(resource);
		if (!this._editStacks.has(strResource)) {
			return;
		}

		const editStack = this._editStacks.get(strResource)!;
		if (editStack.past.length === 0) {
			return;
		}

		const element = editStack.past[editStack.past.length - 1];
		if (element.type === UndoRedoElementType.Workspace) {
			return this._workspaceUndo(resource, element);
		} else {
			return this._resourceUndo(editStack, element);
		}
	}

	public canRedo(resource: URI): boolean {
		const strResource = uriGetComparisonKey(resource);
		if (this._editStacks.has(strResource)) {
			const editStack = this._editStacks.get(strResource)!;
			return (editStack.future.length > 0);
		}
		return false;
	}

	private _workspaceRedo(resource: URI, element: WorkspaceStackElement): Promise<void> | void {
		if (element.removedResources) {
			this._splitFutureWorkspaceElement(element, element.removedResources.set);
			const message = nls.localize('cannotWorkspaceRedo', "Could not redo '{0}' across all files. {1}", element.label, element.removedResources.createMessage());
			this._notificationService.info(message);
			return;
		}

		// this must be the last future element in all the impacted resources!
		let affectedEditStacks: ResourceEditStack[] = [];
		for (const strResource of element.strResources) {
			affectedEditStacks.push(this._editStacks.get(strResource)!);
		}

		let cannotRedoDueToResources: URI[] = [];
		for (const editStack of affectedEditStacks) {
			if (editStack.future.length === 0 || editStack.future[editStack.future.length - 1] !== element) {
				cannotRedoDueToResources.push(editStack.resource);
			}
		}

		if (cannotRedoDueToResources.length > 0) {
			this._splitFutureWorkspaceElement(element, null);
			const paths = cannotRedoDueToResources.map(r => r.scheme === Schemas.file ? r.fsPath : r.path);
			const message = nls.localize('cannotWorkspaceRedoDueToChanges', "Could not redo '{0}' across all files because changes were made to {1}", element.label, paths.join(', '));
			this._notificationService.info(message);
			return;
		}

		for (const editStack of affectedEditStacks) {
			editStack.future.pop();
			editStack.past.push(element);
		}
		return this._safeInvoke(element, () => element.actual.redo());
	}

	private _resourceRedo(editStack: ResourceEditStack, element: ResourceStackElement): Promise<void> | void {
		editStack.future.pop();
		editStack.past.push(element);
		return this._safeInvoke(element, () => element.actual.redo());
	}

	public redo(resource: URI): Promise<void> | void {
		const strResource = uriGetComparisonKey(resource);
		if (!this._editStacks.has(strResource)) {
			return;
		}

		const editStack = this._editStacks.get(strResource)!;
		if (editStack.future.length === 0) {
			return;
		}

		const element = editStack.future[editStack.future.length - 1];
		if (element.type === UndoRedoElementType.Workspace) {
			return this._workspaceRedo(resource, element);
		} else {
			return this._resourceRedo(editStack, element);
		}
	}
}

registerSingleton(IUndoRedoService, UndoRedoService);
