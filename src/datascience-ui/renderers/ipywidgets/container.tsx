// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as isonline from 'is-online';
import * as React from 'react';
import { createDeferred, Deferred } from '../../../client/common/utils/async';
import { IPyWidgetMessages } from '../../../client/datascience/interactive-common/interactiveWindowTypes';
import { WidgetScriptSource } from '../../../client/datascience/ipywidgets/types';
import { SharedMessages } from '../../../client/datascience/messages';
import { IDataScienceExtraSettings } from '../../../client/datascience/types';
// import '../../client/common/extensions';
import { warnAboutWidgetVersionsThatAreNotSupported } from './incompatibleWidgetHandler';
import { WidgetManager } from './manager';
import { registerScripts } from './requirejsRegistry';
import { IPyWidgetsPostOffice } from './types';

type Props = {
    postOffice: IPyWidgetsPostOffice;
    widgetContainerElement: string | HTMLElement;
};

export class WidgetManagerComponent extends React.Component<Props> {
    private readonly widgetManager: WidgetManager;
    private readonly widgetSourceRequests = new Map<
        string,
        { deferred: Deferred<void>; timer: NodeJS.Timeout | number | undefined }
    >();
    private readonly registeredWidgetSources = new Map<string, WidgetScriptSource>();
    private timedOutWaitingForWidgetsToGetLoaded?: boolean;
    private widgetsCanLoadFromCDN: boolean = false;
    private readonly loaderSettings = {
        // Total time to wait for a script to load. This includes ipywidgets making a request to extension for a Uri of a widget,
        // then extension replying back with the Uri (max 5 seconds round trip time).
        // If expires, then Widget downloader will attempt to download with what ever information it has (potentially failing).
        // Note, we might have a message displayed at the user end (asking for consent to use CDN).
        // Hence use 60 seconds.
        timeoutWaitingForScriptToLoad: 60_000,
        // List of widgets that must always be loaded using requirejs instead of using a CDN or the like.
        widgetsRegisteredInRequireJs: new Set<string>(),
        // Callback when loading a widget fails.
        errorHandler: this.handleLoadError.bind(this),
        // Callback when requesting a module be registered with requirejs (if possible).
        loadWidgetScript: this.loadWidgetScript.bind(this),
        successHandler: this.handleLoadSuccess.bind(this)
    };
    constructor(props: Props) {
        super(props);
        // tslint:disable-next-line: no-console
        console.error('init widgetmanager comopnent');
        const ele =
            typeof this.props.widgetContainerElement === 'string'
                ? document.getElementById(this.props.widgetContainerElement)!
                : this.props.widgetContainerElement;
        this.widgetManager = new WidgetManager(ele, this.props.postOffice, this.loaderSettings);

        props.postOffice.onDidReceiveKernelMessage((msg) => {
            // tslint:disable-next-line: no-any
            const type = msg.type;
            const payload = msg.payload;
            if (type === SharedMessages.UpdateSettings) {
                // tslint:disable-next-line: no-console
                console.error('Got Message 1');
                const settings = JSON.parse(payload) as IDataScienceExtraSettings;
                this.widgetsCanLoadFromCDN = settings.widgetScriptSources.length > 0;
            } else if (
                type === IPyWidgetMessages.IPyWidgets_kernelOptions ||
                type === IPyWidgetMessages.IPyWidgets_onKernelChanged
            ) {
                // tslint:disable-next-line: no-console
                console.error('Got Message 2');
                // This happens when we have restarted a kernel.
                // If user changed the kernel, then some widgets might exist now and some might now.
                this.widgetSourceRequests.clear();
                this.registeredWidgetSources.clear();
            } else {
                console.error('Got unknown Message 2');
            }
        });
    }
    public render() {
        return null;
    }
    public componentWillUnmount() {
        this.widgetManager.dispose();
    }
    private async handleLoadError(
        className: string,
        moduleName: string,
        moduleVersion: string,
        // tslint:disable-next-line: no-any
        error: any,
        timedout: boolean = false
    ) {
        if (!this.props.postOffice.onWidgetLoadFailure) {
            return;
        }
        const isOnline = await isonline.default({ timeout: 1000 });
        this.props.postOffice.onWidgetLoadFailure({
            className,
            moduleName,
            moduleVersion,
            isOnline,
            timedout,
            error,
            cdnsUsed: this.widgetsCanLoadFromCDN
        });
    }
    /**
     * Given a list of the widgets along with the sources, we will need to register them with requirejs.
     * IPyWidgets uses requirejs to dynamically load modules.
     * (https://requirejs.org/docs/api.html)
     * All we're doing here is given a widget (module) name, we register the path where the widget (module) can be loaded from.
     * E.g.
     * requirejs.config({ paths:{
     *  'widget_xyz': '<Url of script without trailing .js>'
     * }});
     */
    private registerScriptSourcesInRequirejs(sources: WidgetScriptSource[]) {
        if (!Array.isArray(sources) || sources.length === 0) {
            return;
        }

        registerScripts(sources);

        // Now resolve promises (anything that was waiting for modules to get registered can carry on).
        sources.forEach((source) => {
            this.registeredWidgetSources.set(source.moduleName, source);
            // We have fetched the script sources for all of these modules.
            // In some cases we might not have the source, meaning we don't have it or couldn't find it.
            let request = this.widgetSourceRequests.get(source.moduleName);
            if (!request) {
                request = {
                    deferred: createDeferred(),
                    timer: undefined
                };
                this.widgetSourceRequests.set(source.moduleName, request);
            }
            request.deferred.resolve();
            if (request.timer !== undefined) {
                // tslint:disable-next-line: no-any
                clearTimeout(request.timer as any); // This is to make this work on Node and Browser
            }
        });
    }
    private registerScriptSourceInRequirejs(source?: WidgetScriptSource) {
        if (!source) {
            return;
        }
        this.registerScriptSourcesInRequirejs([source]);
    }

    /**
     * Method called by ipywidgets to get the source for a widget.
     * When we get a source for the widget, we register it in requriejs.
     * We need to check if it is available on CDN, if not then fallback to local FS.
     * Or check local FS then fall back to CDN (depending on the order defined by the user).
     */
    private loadWidgetScript(moduleName: string, moduleVersion: string): Promise<void> {
        // tslint:disable-next-line: no-console
        console.log(`Fetch IPyWidget source for ${moduleName}`);
        let request = this.widgetSourceRequests.get(moduleName);
        if (!request) {
            request = {
                deferred: createDeferred<void>(),
                timer: undefined
            };

            // If we timeout, then resolve this promise.
            // We don't want the calling code to unnecessary wait for too long.
            // Else UI will not get rendered due to blocking ipywidets (at the end of the day ipywidgets gets loaded via kernel)
            // And kernel blocks the UI from getting processed.
            // Also, if we timeout once, then for subsequent attempts, wait for just 1 second.
            // Possible user has ignored some UI prompt and things are now in a state of limbo.
            // This way things will fall over sooner due to missing widget sources.
            const timeoutTime = this.timedOutWaitingForWidgetsToGetLoaded
                ? 5_000
                : this.loaderSettings.timeoutWaitingForScriptToLoad;

            request.timer = setTimeout(() => {
                if (request && !request.deferred.resolved) {
                    // tslint:disable-next-line: no-console
                    console.error(`Timeout waiting to get widget source for ${moduleName}, ${moduleVersion}`);
                    this.handleLoadError(
                        '<class>',
                        moduleName,
                        moduleVersion,
                        new Error(`Timeout getting source for ${moduleName}:${moduleVersion}`),
                        true
                        // tslint:disable-next-line: no-console
                    ).catch((ex) => console.error('Failed to load in container.tsx', ex));
                    request.deferred.resolve();
                    this.timedOutWaitingForWidgetsToGetLoaded = true;
                }
            }, timeoutTime);

            this.widgetSourceRequests.set(moduleName, request);
        }
        // Whether we have the scripts or not, send message to extension.
        // Useful telemetry and also we know it was explicity requested by ipywidgets.
        this.props.postOffice
            .getWidgetScriptSource({
                moduleName,
                moduleVersion
            })
            .then((result) => this.registerScriptSourceInRequirejs(result))
            // tslint:disable-next-line: no-console
            .catch((ex) => console.error(`Failed to fetch scripts for ${moduleName}, ${moduleVersion}`, ex));

        return (
            request.deferred.promise
                .then(() => {
                    // tslint:disable-next-line: no-console
                    console.error('Attempting to load module');
                    const widgetSource = this.registeredWidgetSources.get(moduleName);
                    if (widgetSource) {
                        warnAboutWidgetVersionsThatAreNotSupported(
                            widgetSource,
                            moduleVersion,
                            this.widgetsCanLoadFromCDN,
                            (info) => {
                                if (this.props.postOffice.onWidgetVersionNotSupported) {
                                    this.props.postOffice.onWidgetVersionNotSupported({
                                        moduleName: info.moduleName,
                                        moduleVersion: info.moduleVersion
                                    });
                                }
                            }
                        );
                    }
                })
                // tslint:disable-next-line: no-any
                .catch((ex: any) =>
                    // tslint:disable-next-line: no-console
                    console.error(
                        `Failed to load Widget Script from Extension for for ${moduleName}, ${moduleVersion}`,
                        ex
                    )
                )
        );
    }
    private handleLoadSuccess(className: string, moduleName: string, moduleVersion: string) {
        if (!this.props.postOffice.onWidgetLoadSuccess) {
            return;
        }
        this.props.postOffice.onWidgetLoadSuccess({
            className,
            moduleName,
            moduleVersion
        });
    }
}