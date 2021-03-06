/* eslint-disable header/header */
/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
// Copied from 'terminal-widget.ts' with some modifications, CQ: https://dev.eclipse.org/ipzilla/show_bug.cgi?id=16269

import {
  ATTACH_TERMINAL_SEGMENT,
  RemoteTerminalServerProxy,
  RemoteTerminalWatcher,
} from '../server-definition/remote-terminal-protocol';
import { IBaseTerminalServer, TerminalProcessInfo } from '@theia/terminal/lib/common/base-terminal-protocol';
import { OutputChannel, OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { inject, injectable, postConstruct } from 'inversify';

import { Deferred } from '@theia/core/lib/common/promise-util';
import { Disposable } from 'vscode-jsonrpc';
import { IDisposable } from 'xterm';
import { Message } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { RemoteWebSocketConnectionProvider } from '../server-definition/remote-connection';
import { TerminalProxyCreatorProvider } from '../server-definition/terminal-proxy-creator';
import { TerminalWidgetImpl } from '@theia/terminal/lib/browser/terminal-widget-impl';
import { TerminalWidgetOptions } from '@theia/terminal/lib/browser/base/terminal-widget';
import URI from '@theia/core/lib/common/uri';

export const REMOTE_TERMINAL_TARGET_SCOPE = 'remote-terminal';
export const REMOTE_TERMINAL_WIDGET_FACTORY_ID = 'remote-terminal';
export const RemoteTerminalWidgetOptions = Symbol('RemoteTerminalWidgetOptions');
export interface RemoteTerminalWidgetOptions extends Partial<TerminalWidgetOptions> {
  machineName: string;
  workspaceId: string;
  closeWidgetOnExitOrError: boolean;
}

export interface RemoteTerminalWidgetFactoryOptions extends Partial<TerminalWidgetOptions> {
  /* a unique string per terminal */
  created: string;
}

@injectable()
export class RemoteTerminalWidget extends TerminalWidgetImpl {
  public static OUTPUT_CHANNEL_NAME = 'remote-terminal';

  protected termServer: RemoteTerminalServerProxy | undefined;
  protected waitForRemoteConnection: Deferred<ReconnectingWebSocket> | undefined =
    new Deferred<ReconnectingWebSocket>();

  @inject('TerminalProxyCreatorProvider')
  protected readonly termProxyCreatorProvider: TerminalProxyCreatorProvider;

  @inject(RemoteWebSocketConnectionProvider)
  protected readonly remoteWebSocketConnectionProvider: RemoteWebSocketConnectionProvider;

  @inject(RemoteTerminalWatcher)
  protected readonly remoteTerminalWatcher: RemoteTerminalWatcher;

  @inject(RemoteTerminalWidgetOptions)
  options: RemoteTerminalWidgetOptions;

  @inject(MessageService)
  protected readonly messageService: MessageService;

  @inject(OutputChannelManager)
  protected readonly outputChannelManager: OutputChannelManager;

  private socket: ReconnectingWebSocket;
  protected channel: OutputChannel;
  protected closeOutputConnectionDisposable: Disposable;
  protected processGone: boolean;
  private terminalApiEndPoint: URI | undefined;

  @postConstruct()
  protected init(): void {
    super.init();
    this.channel = this.outputChannelManager.getChannel(RemoteTerminalWidget.OUTPUT_CHANNEL_NAME);

    this.toDispose.push(
      this.remoteTerminalWatcher.onTerminalExecExit(exitEvent => {
        if (this.terminalId === exitEvent.id) {
          this.processGone = true;
          if (this.options.closeWidgetOnExitOrError) {
            this.dispose();
          } else {
            this.closeOutputConnectionDisposable.dispose();
          }
          this.onTermDidClose.fire(this);
          this.onTermDidClose.dispose();
        }
      })
    );

    this.toDispose.push(
      this.term.onTitleChange((title: string) => {
        if (this.options.useServerTitle) {
          this.title.label = this.options.machineName + ': ' + title;
        }
      })
    );

    const badDefaultLoginErr = 'command terminated with exit code 126';
    const missedPrivilegesErr = 'cannot create resource "pods/exec"';
    this.toDispose.push(
      this.remoteTerminalWatcher.onTerminalExecError(errEvent => {
        if (this.terminalId === errEvent.id) {
          this.processGone = true;
          if (this.options.closeWidgetOnExitOrError) {
            this.dispose();
          } else {
            this.closeOutputConnectionDisposable.dispose();
          }
          this.onTermDidClose.fire(this);
          this.onTermDidClose.dispose();

          this.logger.error(`Terminal error: ${errEvent.stack}`);
          this.channel.appendLine(errEvent.stack);

          let reason = '';
          if (errEvent.stack.indexOf(badDefaultLoginErr) !== -1) {
            reason = 'Possible reason is terminal cannot open default login shell. ';
          } else if (errEvent.stack.indexOf(missedPrivilegesErr) !== -1) {
            reason = 'Possible reason is workspace service account lacks some privileges. ';
          }
          reason += 'See more in "Output".';
          this.messageService.error(`Terminal failed to connect. ${reason}`);
        }
      })
    );
  }

  async start(id?: number): Promise<number> {
    try {
      if (!this.termServer) {
        const termProxyCreator = await this.termProxyCreatorProvider();
        this.termServer = termProxyCreator.create();
        this.terminalApiEndPoint = termProxyCreator.getApiEndPointUrl();

        this.toDispose.push(
          this.termServer.onDidCloseConnection(() => {
            const disposable = this.termServer!.onDidOpenConnection(async () => {
              disposable.dispose();
              this.waitForRemoteConnection = new Deferred<ReconnectingWebSocket>();
              await this.reconnectTerminalProcess();
            });
            this.toDispose.push(disposable);
          })
        );
      }
    } catch (err) {
      throw new Error('Failed to create terminal server proxy. Cause: ' + err);
    }

    this._terminalId = typeof id !== 'number' ? await this.createTerminal() : await this.attachTerminal(id);

    this.connectTerminalProcess();

    await this.waitForRemoteConnection!.promise;
    // Some delay need to attach exec. If we send resize earlier this size will be skipped.
    setTimeout(async () => {
      this.resizeTerminalProcess();
    }, 100);

    if (IBaseTerminalServer.validateId(this.terminalId)) {
      this.onDidOpenEmitter.fire(undefined);
      return this.terminalId;
    }
    throw new Error('Failed to start terminal' + (id ? ` for id: ${id}.` : '.'));
  }

  protected async reconnectTerminalProcess(): Promise<void> {
    if (typeof this.terminalId === 'number') {
      let termId;
      try {
        termId = await this.termServer!.check({ id: this.terminalId });
      } catch (error) {
        termId = -1;
      }

      if (!IBaseTerminalServer.validateId(termId)) {
        return;
      }
      await this.start(this.terminalId);
    }
  }

  protected async connectTerminalProcess(): Promise<void> {
    if (typeof this.terminalId !== 'number') {
      return;
    }
    this.toDisposeOnConnect.dispose();
    await this.connectSocket(this.terminalId);
  }

  get cwd(): Promise<URI> {
    // It is not possible to retrieve current working directory of a terminal process which is run via exec mechanism.
    // But we have to override this method to avoid requesting wrong terminal backend.
    // Returning empty cwd will result in some features not working in some cases (for example opening files in editor by
    //  relative link from terminal with exec backend), however it will prevent some errors.
    return Promise.resolve(new URI());
  }

  get processId(): Promise<number> {
    return (async () => {
      if (!IBaseTerminalServer.validateId(this.terminalId)) {
        throw new Error('terminal is not started');
      }
      // Exec server side unable to return real process pid. This information is encapsulated.
      return this.terminalId;
    })();
  }

  get processInfo(): Promise<TerminalProcessInfo> {
    return (async () => {
      if (!IBaseTerminalServer.validateId(this.terminalId)) {
        throw new Error('terminal is not started');
      }
      return { executable: '/bin/bash', arguments: [] };
    })();
  }

  protected async connectSocket(id: number): Promise<void> {
    if (this.socket) {
      this.resolveRemoteConnection();
      return Promise.resolve();
    }

    this.socket = this.createWebSocket(this.terminalApiEndPoint!);

    const sendListener = (data: string) => this.socket.send(data);

    let onDataDisposeHandler: IDisposable;
    this.socket.onopen = () => {
      this.term.reset();
      this.resolveRemoteConnection();

      onDataDisposeHandler = this.term.onData(sendListener);
      this.socket.onmessage = ev => this.write(ev.data);

      this.closeOutputConnectionDisposable = Disposable.create(() => {
        onDataDisposeHandler.dispose();
        this.socket.close();
      });
      this.toDispose.push(this.closeOutputConnectionDisposable);

      return Promise.resolve();
    };

    this.socket.onerror = err => {
      this.messageService.error(`Terminal failed to connect. ${err.message}.`);
      if (onDataDisposeHandler) {
        onDataDisposeHandler.dispose();
      }
      return Promise.resolve();
    };

    this.socket.onclose = code => {
      if (onDataDisposeHandler) {
        onDataDisposeHandler.dispose();
      }
      return Promise.resolve();
    };
  }

  protected createWebSocket(apiEndPoint: URI): ReconnectingWebSocket {
    const url = apiEndPoint.resolve(ATTACH_TERMINAL_SEGMENT).resolve(this.terminalId + '');
    return new ReconnectingWebSocket(url.toString(true), undefined, {
      maxReconnectionDelay: 10000,
      minReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1.3,
      connectionTimeout: 10000,
      maxRetries: Infinity,
      debug: false,
    });
  }

  protected async attachTerminal(id: number): Promise<number> {
    let termId;
    try {
      termId = await this.termServer!.check({ id: id });
    } catch (error) {
      termId = -1;
    }

    if (IBaseTerminalServer.validateId(termId) || this.kind !== 'user') {
      return termId;
    }
    this.logger.error(
      `Error attaching to terminal id ${id}, the terminal is most likely gone. Starting up a new terminal instead.`
    );
    return this.createTerminal();
  }

  protected async createTerminal(): Promise<number> {
    const cols = this.term.cols;
    const rows = this.term.rows;
    let cmd: string[] = [];
    if (this.options.shellPath) {
      cmd = [this.options.shellPath, ...(this.options.shellArgs || [])];
    }

    const machineExec = {
      identifier: {
        machineName: this.options.machineName,
        workspaceId: this.options.workspaceId,
      },
      cmd: cmd,
      cwd: this.options.cwd,
      cols,
      rows,
      tty: true,
    };

    const termId = await this.termServer!.create(machineExec);
    if (IBaseTerminalServer.validateId(termId)) {
      return termId;
    }
    throw new Error('Error creating terminal widget');
  }

  protected resizeTerminalProcess(): void {
    if (this.processGone) {
      return;
    }

    if (!IBaseTerminalServer.validateId(this.terminalId) && !this.terminalService.getById(this.id)) {
      return;
    }

    const cols = this.term.cols;
    const rows = this.term.rows;

    if (this.termServer && this.termServer.resize) {
      this.termServer.resize({ id: this.terminalId, cols, rows }).catch(() => {});
    }
  }

  sendText(text: string): void {
    if (this.waitForRemoteConnection) {
      this.waitForRemoteConnection.promise.then(socket => socket.send(text));
    }
  }

  protected onCloseRequest(msg: Message): void {
    this.closeOnDispose = true;
    super.onCloseRequest(msg);
  }

  dispose(): void {
    if (!this.closeOnDispose || !this.options.attributes || !this.options.attributes.interruptProcessOnClose) {
      super.dispose();
      return;
    }

    this.interruptProcess().then(() => {
      super.dispose();
    });
  }

  private resolveRemoteConnection(): void {
    if (this.waitForRemoteConnection) {
      this.waitForRemoteConnection.resolve(this.socket);
    }
  }

  private async interruptProcess(): Promise<void> {
    try {
      const termId = await this.termServer!.check({ id: this.terminalId });
      if (!IBaseTerminalServer.validateId(termId)) {
        return;
      }

      if (this.waitForRemoteConnection) {
        const socket = await this.waitForRemoteConnection.promise;
        socket.send('\x03');
      }
    } catch (error) {}
  }
}
