// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import type { nbformat } from '@jupyterlab/coreutils/lib/nbformat';
import { inject } from 'inversify';
import { Memento } from 'vscode';
import { NotebookDocument } from '../../../../types/vscode-proposed';
import { IExtensionSingleActivationService } from '../../activation/types';
import { IVSCodeNotebook } from '../../common/application/types';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { traceWarning } from '../../common/logger';
import { GLOBAL_MEMENTO, IDisposableRegistry } from '../../common/types';
import { swallowExceptions } from '../../common/utils/decorators';
import { translateKernelLanguageToMonaco } from '../common';
import { IJupyterKernelSpec } from '../types';
// tslint:disable-next-line: no-var-requires no-require-imports
const vscodeNotebookEnums = require('vscode') as typeof import('vscode-proposed');

const LastSavedNotebookCellLanguage = 'DATASCIENCE.LAST_SAVED_CELL_LANGUAGE';
/**
 * Responsible for determining the default language of a cell for new notebooks.
 * It should not always be `Python`, not all data scientists or users of notebooks use Python.
 */
export class NotebookCellLanguageService implements IExtensionSingleActivationService {
    constructor(
        @inject(IVSCodeNotebook) private readonly vscNotebook: IVSCodeNotebook,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(GLOBAL_MEMENTO) private readonly globalMemento: Memento
    ) {}
    public getPreferredLanguage(metadata?: nbformat.INotebookMetadata) {
        const jupyterLanguage =
            metadata?.language_info?.name || (metadata?.kernelspec as IJupyterKernelSpec | undefined)?.language;
        return translateKernelLanguageToMonaco(jupyterLanguage || PYTHON_LANGUAGE);
    }
    public async activate() {
        this.vscNotebook.onDidSaveNotebookDocument(this.onDidSaveNotebookDocument, this, this.disposables);
    }
    private get lastSavedNotebookCellLanguage(): string | undefined {
        return this.globalMemento.get<string | undefined>(LastSavedNotebookCellLanguage);
    }
    @swallowExceptions('Saving last saved cell language')
    private async onDidSaveNotebookDocument(doc: NotebookDocument) {
        const language = this.getLanguageOfFirstCodeCell(doc);
        if (language && language !== this.lastSavedNotebookCellLanguage) {
            await this.globalMemento.update(LastSavedNotebookCellLanguage, language);
        }
    }
    private getLanguageOfFirstCodeCell(doc: NotebookDocument) {
        // If the document has been closed, accessing cell information can fail.
        // Ignore such exceptions.
        try {
            return doc.cells.find((cell) => cell.cellKind === vscodeNotebookEnums.CellKind.Code)?.language;
        } catch (ex) {
            traceWarning('Failed to determine language of first cell', ex);
        }
    }
}
