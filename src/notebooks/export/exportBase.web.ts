// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type * as nbformat from '@jupyterlab/nbformat';
import type { Contents, ContentsManager } from '@jupyterlab/services';
import { inject, injectable } from 'inversify';
import { Uri, CancellationToken, NotebookDocument } from 'vscode';
import * as path from '../../platform/vscode-path/path';
import { DisplayOptions } from '../../kernels/displayOptions';
import { executeSilently } from '../../kernels/helpers';
import {
    IJupyterConnection,
    IKernel,
    IKernelProvider,
    RemoteKernelConnectionMetadata,
    isRemoteConnection
} from '../../kernels/types';
import { concatMultilineString } from '../../platform/common/utils';
import { IFileSystem } from '../../platform/common/platform/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { ExportUtilBase } from './exportUtil';
import { ExportFormat, IExportBase, IExportDialog, INbConvertExport } from './types';
import { traceLog } from '../../platform/logging';
import { reportAction } from '../../platform/progress/decorator';
import { ReportableAction } from '../../platform/progress/types';
import { SessionDisposedError } from '../../platform/errors/sessionDisposedError';
import { IBackupFile, IJupyterBackingFileCreator } from '../../kernels/jupyter/types';
import { Resource } from '../../platform/common/types';
import { noop } from '../../platform/common/utils/misc';
import { JupyterConnection } from '../../kernels/jupyter/connection/jupyterConnection';

/**
 * Base class for exporting on web. Uses the kernel to perform the export and then translates the blob sent back to a file.
 */
@injectable()
export class ExportBase implements INbConvertExport, IExportBase {
    constructor(
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(IExportDialog) protected readonly filePicker: IExportDialog,
        @inject(ExportUtilBase) protected readonly exportUtil: ExportUtilBase,
        @inject(IJupyterBackingFileCreator) private readonly backingFileCreator: IJupyterBackingFileCreator,
        @inject(JupyterConnection) private readonly jupyterConnection: JupyterConnection
    ) {}

    public async export(
        _sourceDocument: NotebookDocument,
        _target: Uri,
        _interpreter: PythonEnvironment,
        _token: CancellationToken
    ): Promise<void> {
        return undefined;
    }

    @reportAction(ReportableAction.PerformingExport)
    async executeCommand(
        sourceDocument: NotebookDocument,
        target: Uri,
        format: ExportFormat,
        _interpreter: PythonEnvironment,
        _token: CancellationToken
    ): Promise<void> {
        const kernel = this.kernelProvider.get(sourceDocument);
        if (!kernel) {
            // trace error
            return;
        }
        if (!kernel.session) {
            await kernel.start(new DisplayOptions(false));
        }
        if (!kernel.session?.kernel) {
            return;
        }

        const kernelConnectionMetadata = kernel.kernelConnectionMetadata;
        const resource = kernel.resourceUri;
        if (!isRemoteConnection(kernelConnectionMetadata)) {
            return;
        }
        if (resource) {
            return;
        }
        const kernelConnection = kernel.session.kernel;
        const connection = await this.jupyterConnection.createConnectionInfo(
            kernelConnectionMetadata.serverProviderHandle
        );
        const serverSettings = await this.jupyterConnection.getServerConnectSettings(connection);
        const jupyter = require('@jupyterlab/services') as typeof import('@jupyterlab/services');
        const contentsManager = new jupyter.ContentsManager({ serverSettings });

        let contents = await this.exportUtil.getContent(sourceDocument);

        let fileExt = '';

        switch (format) {
            case ExportFormat.html:
                fileExt = '.html';
                break;
            case ExportFormat.pdf:
                fileExt = '.pdf';
                break;
            case ExportFormat.python:
                fileExt = '.py';
                break;
        }

        const backingFile = await this.backingFileCreator.createBackingFile(
            resource,
            Uri.file(''),
            kernelConnectionMetadata,
            connection,
            contentsManager
        );

        if (!backingFile) {
            return;
        }
        await contentsManager
            .save(backingFile!.filePath, {
                content: JSON.parse(contents),
                type: 'notebook'
            })
            .catch(noop);

        let tempTarget: string | undefined;
        try {
            const pwd = await this.getCWD(kernel);
            const tempFile = await contentsManager.newUntitled({ type: 'file', ext: fileExt });
            tempTarget = tempFile.path;
            const filePath = `${pwd}/${backingFile.filePath}`;

            const outputs = await executeSilently(
                kernelConnection,
                `!jupyter nbconvert ${filePath} --to ${format} --output ${path.basename(tempTarget)}`
            );

            const text = this.parseStreamOutput(outputs);
            if (this.isExportFailed(text)) {
                throw new Error(text || `Failed to export to ${format}`);
            } else if (text) {
                // trace the output in case we didn't identify all errors
                traceLog(text);
            }

            if (format === ExportFormat.pdf) {
                const content = await contentsManager.get(tempTarget, {
                    type: 'file',
                    format: 'base64',
                    content: true
                });
                const bytes = this.b64toBlob(content.content, 'application/pdf');
                const buffer = await bytes.arrayBuffer();
                await this.fs.writeFile(target!, Buffer.from(buffer));
            } else {
                const content = await contentsManager.get(tempTarget, {
                    type: 'file',
                    format: 'text',
                    content: true
                });
                await this.fs.writeFile(target!, content.content as string);
            }
        } finally {
            if (tempTarget) {
                await contentsManager.delete(tempTarget);
            }
            await backingFile.dispose();
            await contentsManager.delete(backingFile.filePath).catch(noop);
            contentsManager.dispose();
        }
    }
    async invokeWithFileSynced(
        resource: Resource,
        contents: string,
        kernelConnectionMetadata: RemoteKernelConnectionMetadata,
        connInfo: IJupyterConnection,
        contentsManager: ContentsManager,
        handler: (file: IBackupFile) => Promise<void>
    ): Promise<void> {
        if (!resource) {
            return;
        }

        const backingFile = await this.backingFileCreator.createBackingFile(
            resource,
            Uri.file(''),
            kernelConnectionMetadata,
            connInfo,
            contentsManager
        );

        if (!backingFile) {
            return;
        }

        await contentsManager
            .save(backingFile!.filePath, {
                content: JSON.parse(contents),
                type: 'notebook'
            })
            .catch(noop);

        await handler({
            filePath: backingFile.filePath,
            dispose: backingFile.dispose.bind(backingFile)
        });

        await backingFile.dispose();
        await contentsManager.delete(backingFile.filePath).catch(noop);
    }

    async getContents(
        file: string,
        format: Contents.FileFormat,
        contentsManager: ContentsManager
    ): Promise<Contents.IModel> {
        const data = await contentsManager.get(file, { type: 'file', format: format, content: true });
        return data;
    }

    private b64toBlob(b64Data: string, contentType: string | undefined) {
        contentType = contentType || '';
        const sliceSize = 512;
        b64Data = b64Data.replace(/^[^,]+,/, '');
        b64Data = b64Data.replace(/\s/g, '');
        const byteCharacters = atob(b64Data);
        let byteArrays = [];

        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);

            let byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }

            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }

        const blob = new Blob(byteArrays, { type: contentType });
        return blob;
    }

    private isExportFailed(message: string | undefined) {
        if (!message) {
            return true;
        }

        return /Traceback \(most recent call last\)/g.exec(message);
    }

    private parseStreamOutput(outputs: nbformat.IOutput[]): string | undefined {
        if (outputs.length === 0) {
            return;
        }

        const output: nbformat.IStream = outputs[0] as unknown as nbformat.IStream;
        if (output.name !== 'stdout' && output.output_type !== 'stream') {
            return;
        }

        const text = concatMultilineString(output.text).trim();
        return text;
    }

    private async getCWD(kernel: IKernel) {
        if (!kernel.session?.kernel) {
            throw new SessionDisposedError();
        }
        const outputs = await executeSilently(kernel.session.kernel, `import os;os.getcwd();`);
        if (outputs.length === 0) {
            return;
        }

        const output: nbformat.IExecuteResult = outputs[0] as unknown as nbformat.IExecuteResult;
        if (output.output_type !== 'execute_result') {
            return undefined;
        }

        return output.data['text/plain'];
    }
}
