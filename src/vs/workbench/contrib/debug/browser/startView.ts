/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService, RawContextKey, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { localize } from 'vs/nls';
import { StartAction, ConfigureAction } from 'vs/workbench/contrib/debug/browser/debugActions';
import { IDebugService } from 'vs/workbench/contrib/debug/common/debug';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IViewPaneOptions, ViewPane } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IViewDescriptorService, IViewsRegistry, Extensions } from 'vs/workbench/common/views';
import { Registry } from 'vs/platform/registry/common/platform';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { WorkbenchStateContext } from 'vs/workbench/browser/contextkeys';
import { OpenFolderAction, OpenFileAction, OpenFileFolderAction } from 'vs/workbench/browser/actions/workspaceActions';
import { isMacintosh } from 'vs/base/common/platform';
import { isCodeEditor } from 'vs/editor/browser/editorBrowser';

const CONTEXT_DEBUG_START_LANGUAGE = new RawContextKey<string>('debugStartLanguage', undefined);
const CONTEXT_DEBUGGER_INTERESTED_IN_ACTIVE_EDITOR = new RawContextKey<boolean>('debuggerInterestedInActiveEditor', false);

export class StartView extends ViewPane {

	static ID = 'workbench.debug.startView';
	static LABEL = localize('start', "Start");

	private debugStartLanguageContext: IContextKey<string>;
	private debuggerInterestedContext: IContextKey<boolean>;

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IDebugService private readonly debugService: IDebugService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
	) {
		super({ ...(options as IViewPaneOptions), ariaHeaderLabel: localize('debugStart', "Debug Start Section") }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService);

		this.debugStartLanguageContext = CONTEXT_DEBUG_START_LANGUAGE.bindTo(contextKeyService);
		this.debuggerInterestedContext = CONTEXT_DEBUGGER_INTERESTED_IN_ACTIVE_EDITOR.bindTo(contextKeyService);
		const setContextKey = () => {
			const editor = this.editorService.activeTextEditorWidget;
			if (isCodeEditor(editor)) {
				const model = editor.getModel();
				const language = model ? model.getLanguageIdentifier().language : undefined;
				if (language && this.debugService.getConfigurationManager().isDebuggerInterestedInLanguage(language)) {
					this.debugStartLanguageContext.set(language);
					this.debuggerInterestedContext.set(true);
					return;
				}
			}
			this.debuggerInterestedContext.set(false);
		};
		this._register(editorService.onDidActiveEditorChange(setContextKey));
		this._register(this.debugService.getConfigurationManager().onDidRegisterDebugger(setContextKey));
	}

	shouldShowWelcome(): boolean {
		return true;
	}
}

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
viewsRegistry.registerViewWelcomeContent(StartView.ID, {
	content: localize('openAFileWhichCanBeDebugged', "[Open a file](command:{0}) which can be debugged or run.", isMacintosh ? OpenFileFolderAction.ID : OpenFileAction.ID),
	when: CONTEXT_DEBUGGER_INTERESTED_IN_ACTIVE_EDITOR
});

viewsRegistry.registerViewWelcomeContent(StartView.ID, {
	content: localize('runAndDebugAction', "[Run and Debug](command:{0})", StartAction.ID)
});

viewsRegistry.registerViewWelcomeContent(StartView.ID, {
	content: localize('customizeRunAndDebug', "To customize Run and Debug [create a launch.json file](command:{0}).", ConfigureAction.ID),
	when: WorkbenchStateContext.notEqualsTo('empty')
});

viewsRegistry.registerViewWelcomeContent(StartView.ID, {
	content: localize('customizeRunAndDebugOpenFolder', "To customize Run and Debug, [open a folder](command:{0}) and create a launch.json file.", isMacintosh ? OpenFileFolderAction.ID : OpenFolderAction.ID),
	when: WorkbenchStateContext.isEqualTo('empty')
});
