/*
 * Copyright (c) 2021 Red Hat, Inc.
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

/**
 * Mock of @theia/plugin module
 * @author Florent Benoit
 */
const theia: any = {};
theia.window = {
    createTreeView: jest.fn()
};
theia.EventEmitter = class EventEmitter {}
theia.Disposable = {
    create: jest.fn()
}
theia.commands = {
    registerCommand: jest.fn()
}
module.exports = theia;
