/**********************************************************************
 * Copyright (c) 2018-2020 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line spaced-comment
/// <reference path="index.d.ts"/>

import * as cp from 'child_process';
import * as fs from 'fs-extra';
import * as json2yaml from 'json2yaml';
import * as mustache from 'mustache';
import * as path from 'path';
import * as tmp from 'tmp';
import * as yargs from 'yargs';

import { AssemblyConfiguration, generateAssembly } from '../../src/generate-assembly';
import { ISource, InitSources } from '../../src/init-sources';

import { YargsMockup } from '../cdn.spec';

jest.setTimeout(10000);

describe('Test Extensions', () => {
    // Increase timeout to 30 seconds
    jest.setTimeout(30000);

    const THEIA_DUMMY_VERSION = '1.2.3';

    const assemblyTestConfig: AssemblyConfiguration = {
        theiaVersion: THEIA_DUMMY_VERSION,
        monacoVersion: '',
        configDirPrefix: '../../',
        packageRefPrefix: '../che-theia/extensions/',
    };

    const rootFolder = process.cwd();
    const templatesPath = path.resolve(rootFolder, 'tests/init-sources/templates');
    const extensionExample1Path = path.resolve(rootFolder, 'tests/init-sources/extension-example');
    const extensionExample2Path = path.resolve(rootFolder, 'tests/init-sources/extension-example2');
    let rootFolderTmp: string;
    let packagesFolderTmp: string;
    let pluginsFolderTmp: string;
    let assemblyFolderTmp: string;
    let cheTheiaFolderTmp: string;
    let sourceExtension1Tmp: string;
    let sourceExtension2Tmp: string;
    let extensionYamlTmp: string;
    let theiaCorePackageTmp: string;

    beforeEach(async () => {
        rootFolderTmp = tmp.dirSync({ mode: 0o750, prefix: 'tmpExtensions', postfix: '' }).name;
        assemblyFolderTmp = path.resolve(rootFolderTmp, 'assembly');

        packagesFolderTmp = path.resolve(rootFolderTmp, 'packages');
        pluginsFolderTmp = path.resolve(rootFolderTmp, 'plugins');
        cheTheiaFolderTmp = path.resolve(rootFolderTmp, 'che-theia');
        sourceExtension1Tmp = path.resolve(rootFolderTmp, 'source-code1');
        sourceExtension2Tmp = path.resolve(rootFolderTmp, 'source-code2');
        extensionYamlTmp = path.resolve(rootFolderTmp, 'extensions.yml');
        theiaCorePackageTmp = path.resolve(packagesFolderTmp, 'core');

        await fs.ensureDir(rootFolderTmp);
        await fs.copy(path.join(templatesPath, 'theia-root-package.json'), path.join(rootFolderTmp, 'package.json'));

        await fs.ensureDir(packagesFolderTmp);
        await fs.ensureDir(pluginsFolderTmp);

        await fs.ensureDir(assemblyFolderTmp);
        await fs.copy(path.join(templatesPath, 'assembly-package.json'), path.join(assemblyFolderTmp, 'package.json'));

        await fs.copy(
            path.join(templatesPath, 'assembly-tsconfig.json'),
            path.join(assemblyFolderTmp, 'tsconfig.json')
        );

        await fs.ensureDir(theiaCorePackageTmp);
        await fs.copy(
            path.join(templatesPath, 'theia-core-package.json'),
            path.join(packagesFolderTmp, 'core', 'package.json')
        );

        await fs.copy(
            path.join(extensionExample1Path, 'folder1', 'tsconfig.json'), // let's use a tsconfig from an example for core package to not duplicate few times tsconfig
            path.join(packagesFolderTmp, 'core', 'tsconfig.json')
        );

        await fs.ensureDir(sourceExtension1Tmp);
        await fs.copy(path.join(extensionExample1Path), sourceExtension1Tmp);
        initGit(sourceExtension1Tmp);

        await fs.ensureDir(sourceExtension2Tmp);
        await fs.copy(path.join(extensionExample2Path), sourceExtension2Tmp);
        initGit(sourceExtension2Tmp);
    });

    function initGit(cwd: string): void {
        cp.execSync('git init', { cwd });
        cp.execSync('git checkout -b main', { cwd });
        cp.execSync('git config --local user.name "test user"', { cwd });
        cp.execSync('git config --local user.email user@example.com', { cwd });
        cp.execSync(`git add ${cwd}`, { cwd });
        cp.execSync(`git commit -m "Init repo"`, { cwd });
    }

    afterEach(() => {
        // remove tmp directory
        fs.removeSync(rootFolderTmp);
    });

    test('test init sources generator', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const yamlExtensionsContent = {
            sources: [
                {
                    source: 'file://' + sourceExtension1Tmp,
                    extensions: ['folder1', 'folder2'],
                },
                {
                    source: 'file://' + sourceExtension2Tmp,
                    checkoutTo: 'main',
                },
            ],
        };

        const yml = json2yaml.stringify(yamlExtensionsContent);
        fs.writeFileSync(extensionYamlTmp, yml);

        initSources.keepGitHistory = false;
        await initSources.generate(extensionYamlTmp);

        // need to perform checks

        // check that extension has its dependencies/dev dependencies updated
        const contentExt1Folder1 = await fs.readFile(path.join(cheTheiaFolderTmp, 'source-code1/folder1/package.json'));
        const ext1Folder1Package = JSON.parse(contentExt1Folder1.toString());
        expect(ext1Folder1Package.dependencies['@theia/core']).toBe(`^${THEIA_DUMMY_VERSION}`);
        expect(ext1Folder1Package.devDependencies['rimraf']).toBe(`5.6.7`);

        const contentExt1Folder2 = await fs.readFile(path.join(cheTheiaFolderTmp, 'source-code1/folder2/package.json'));
        const ext1Folder2Package = JSON.parse(contentExt1Folder2.toString());
        expect(ext1Folder2Package.dependencies['@theia/browser']).toBe(`^${THEIA_DUMMY_VERSION}`);
        expect(ext1Folder2Package.dependencies['@theia/core']).toBe(`^${THEIA_DUMMY_VERSION}`);
        expect(ext1Folder2Package.devDependencies['rimraf']).toBe(`5.6.7`);

        const contentExt2 = await fs.readFile(path.join(cheTheiaFolderTmp, 'source-code2/package.json'));
        const ext2Package = JSON.parse(contentExt2.toString());
        expect(ext2Package.dependencies['@theia/core']).toBe(`^${THEIA_DUMMY_VERSION}`);
        expect(ext2Package.devDependencies['rimraf']).toBe(`5.6.7`);
        expect(ext2Package.devDependencies['unknown-dependencies']).toBe(`0.0.1`);

        // check symlink are ok as well
        const ext1Folder1Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder1`)
        );
        expect(ext1Folder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder1'));
        const ext1Folder2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder2`)
        );
        expect(ext1Folder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder2'));

        const ext2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}source-code2`)
        );
        expect(ext2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code2'));

        // check extension have been added into the assembly
        const assemblyResult = await fs.readFile(path.join(assemblyFolderTmp, 'package.json'));
        const assemblyPackage = JSON.parse(assemblyResult.toString());
        expect(assemblyPackage.dependencies['@che-theia/sample1']).toBe('0.1.2');
        expect(assemblyPackage.dependencies['@che-theia/sample2']).toBe('6.7.8');
        expect(assemblyPackage.dependencies['@che-theia/extension-example2']).toBe('9.8.7');
    });

    test('extension with empty dependencies', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        await initSources.updateDependencies(
            { extSymbolicLinks: [path.resolve(rootFolder, 'tests/init-sources/extension-empty')] } as ISource,
            false
        );
        expect(true).toBeTruthy();
    });

    test('extensions with dev mode', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const yamlExtensionsContent = {
            sources: [
                {
                    source: 'file://' + sourceExtension1Tmp,
                    extensions: ['folder1', 'folder2'],
                },
                {
                    source: 'file://' + sourceExtension2Tmp,
                    checkoutTo: 'foo',
                },
            ],
        };

        const yml = json2yaml.stringify(yamlExtensionsContent);
        fs.writeFileSync(extensionYamlTmp, yml);

        initSources.keepGitHistory = false;
        await initSources.generate(extensionYamlTmp, true);

        // check symlink are ok as well
        const ext1Folder1Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder1`)
        );
        expect(ext1Folder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder1'));
        const ext1Folder2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder2`)
        );
        expect(ext1Folder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder2'));
    });

    test('use provided extensions', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const yamlExtensionsContent = {
            sources: [
                {
                    source: 'file://' + sourceExtension1Tmp,
                    extensions: ['folder1', 'folder2'],
                },
                {
                    source: 'file://' + sourceExtension2Tmp,
                    checkoutTo: 'main',
                },
            ],
        };

        const yml = json2yaml.stringify(yamlExtensionsContent);
        fs.writeFileSync(extensionYamlTmp, yml);

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(extensionYamlTmp, false);

        const ext1Folder1Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder1`)
        );
        expect(ext1Folder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder1'));
        const ext1Folder2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder2`)
        );
        expect(ext1Folder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder2'));
    });

    test('use default extensions', async () => {
        await generateAssembly(assemblyFolderTmp, assemblyTestConfig);

        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            rootFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(undefined, false);

        expect(fs.readdirSync(packagesFolderTmp).length).toBeGreaterThan(0);
    });

    test('use provided extensions with dev mode', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const yamlExtensionsContent = {
            sources: [
                {
                    source: 'file://' + sourceExtension1Tmp,
                    extensions: ['folder1', 'folder2'],
                },
                {
                    source: 'file://' + sourceExtension2Tmp,
                    checkoutTo: 'main',
                },
            ],
        };

        const yml = json2yaml.stringify(yamlExtensionsContent);
        fs.writeFileSync(extensionYamlTmp, yml);

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(extensionYamlTmp, true);

        const ext1Folder1Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder1`)
        );
        expect(ext1Folder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder1'));
        const ext1Folder2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder2`)
        );
        expect(ext1Folder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder2'));
    });

    test('use default extensions with dev mode', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        let generateCalled = false;
        let configurationContent = undefined;
        initSources.generate = jest.fn(async (pathGenerate: string) => {
            generateCalled = true;
            configurationContent = fs.readFileSync(pathGenerate).toString();
        });

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(undefined, true);

        expect(generateCalled).toBe(true);
        expect(configurationContent).toBeTruthy();
    });

    test('throw error if path to configuration does not exist', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        try {
            await initSources.readConfigurationAndGenerate('some/path/foo/bar.yaml', false);
        } catch (e) {
            expect(e.message).toMatch('Config file does not exists');
        }
    });

    test('default extension uri is unreachable', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const uri: string = InitSources.DEFAULT_EXTENSIONS_URI;
        try {
            (<any>InitSources)['DEFAULT_EXTENSIONS_URI'] = 'https://foobarfoo.com/foo/bar';
            await initSources.readConfigurationAndGenerate(undefined, false);
        } catch (e) {
            expect(e.toString()).toMatch('Error: Network Error');
        } finally {
            (<any>InitSources)['DEFAULT_EXTENSIONS_URI'] = uri;
        }
    });

    test('test command options', async () => {
        const yargsMockup = new YargsMockup();
        InitSources.argBuilder(<yargs.Argv>yargsMockup);

        expect(yargsMockup.options['config']).toEqual({
            description: 'Path to custom config file',
            alias: 'c',
        });

        expect(yargsMockup.options['dev']).toEqual({
            description:
                'Initialize current Theia with Che/Theia extensions from "main" branch instead of provided branches',
            alias: 'd',
            type: 'boolean',
            default: false,
        });
    });

    test('use extensions and plugins', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const yamlExtensionsContent = {
            sources: [
                {
                    source: 'file://' + sourceExtension1Tmp,
                    extensions: ['folder1', 'folder2'],
                    plugins: ['plugin-folder1', 'plugin-folder2'],
                },
                {
                    source: 'file://' + sourceExtension2Tmp,
                    checkoutTo: 'main',
                },
            ],
        };

        const yml = json2yaml.stringify(yamlExtensionsContent);
        fs.writeFileSync(extensionYamlTmp, yml);

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(extensionYamlTmp, false);

        const ext1Folder1Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder1`)
        );
        expect(ext1Folder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder1'));
        const ext1Folder2Link = await fs.readlink(
            path.join(packagesFolderTmp, `${InitSources.PREFIX_PACKAGES_EXTENSIONS}folder2`)
        );
        expect(ext1Folder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/folder2'));

        const pluginFolder1Link = await fs.readlink(path.join(pluginsFolderTmp, `plugin-folder1`));
        expect(pluginFolder1Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/plugin-folder1'));
        const pluginFolder2Link = await fs.readlink(path.join(pluginsFolderTmp, `plugin-folder2`));
        expect(pluginFolder2Link).toBe(path.join(cheTheiaFolderTmp, 'source-code1/plugin-folder2'));
    });

    test('aliases replace with local source folder', async () => {
        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        const aliases = [
            'https://github.com/eclipse-che/che-theia=../che-theia',
            'key1=value1',
            '../test=https://github.com/eclipse-che/che-theia',
        ];

        initSources.initSourceLocationAliases(aliases);

        expect(initSources.sourceLocationAliases.get('https://github.com/eclipse-che/che-theia')).toBe('../che-theia');
        expect(initSources.sourceLocationAliases.get('../test')).toBe('https://github.com/eclipse-che/che-theia');
        expect(initSources.sourceLocationAliases.get('test')).toBeUndefined();
    });

    test('should skip clonning if source is an existing folder (and not a git uri to clone) and use it as the clonedDir', async () => {
        const source: ISource = {
            source: sourceExtension1Tmp,
            checkoutTo: '',
            type: '',
            clonedDir: '',
            extensions: [],
            plugins: [],
            extSymbolicLinks: [],
            pluginSymbolicLinks: [],
        };

        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            cheTheiaFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        initSources.keepGitHistory = false;
        initSources.clone(source);

        expect(source.clonedDir).toBe(sourceExtension1Tmp);
    });

    test('check resolving typescript references', async () => {
        await generateAssembly(assemblyFolderTmp, assemblyTestConfig);

        const initSources = new InitSources(
            rootFolderTmp,
            packagesFolderTmp,
            pluginsFolderTmp,
            rootFolderTmp,
            assemblyFolderTmp,
            THEIA_DUMMY_VERSION
        );

        initSources.keepGitHistory = false;
        await initSources.readConfigurationAndGenerate(undefined, false);

        // check that all extensions are placed as references in the assembly tsconfig.json
        const asssemblyTsConfigPath = path.join(assemblyFolderTmp, 'tsconfig.json');
        const actualAssemblyTsConfigReferences = await getTypescriptReferences(asssemblyTsConfigPath);
        const actualPaths = actualAssemblyTsConfigReferences.map(reference => reference.path);

        const templateReferences = await getTemplateTypescriptReferences(assemblyTestConfig);
        const templatePaths = templateReferences.map(reference => reference.path);

        expect(templatePaths.every(reference => actualPaths.includes(reference))).toBeTruthy();

        // check that dependencies from upstream are placed as references in the assembly tsconfig.json
        // within the current suite '@theia/core' package is added, so let's check if it's present as a reference
        expect(actualPaths.includes('../packages/core')).toBeTruthy();

        // check that an extesion contains tsconfig with the corresponding references
        const extensionTsConfigPath = path.join(
            packagesFolderTmp,
            '@che-eclipse-che-theia-activity-tracker',
            'tsconfig.json'
        );
        const extesnionReferences = await getTypescriptReferences(extensionTsConfigPath);
        const extensionReferencesPaths = extesnionReferences.map(reference => reference.path);

        expect(extensionReferencesPaths.includes('../../../packages/core')).toBeTruthy();
        expect(extensionReferencesPaths.includes('../eclipse-che-theia-plugin-ext')).toBeTruthy();
    });
});

async function getTypescriptReferences(tsConfigPath: string): Promise<{ path: string }[]> {
    const tsConfigRawData = await fs.readFile(tsConfigPath);
    const tsConfigParsedData = JSON.parse(tsConfigRawData.toString());
    return tsConfigParsedData.references || [];
}

async function getTemplateTypescriptReferences(config: AssemblyConfiguration): Promise<{ path: string }[]> {
    const templateTsConfigPath = path.join(__dirname, '../../src', 'templates', 'assembly-compile.tsconfig.mst.json');
    const content = await fs.readFile(templateTsConfigPath);

    const rendered = mustache.render(content.toString(), config).replace(/&#x2F;/g, '/');

    const tsConfigParsedData = JSON.parse(rendered);
    return tsConfigParsedData.references || [];
}
