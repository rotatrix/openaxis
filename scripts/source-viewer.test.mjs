import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSymbols, sourceFiles, sourceLink } from '../docs/src/source-files.mjs';

test('C++ reference sources have C++ highlighting and file-level links', () => {
  for (const name of ['main.cpp', 'integration.hpp', 'application.cpp', 'application.hpp']) {
    const path = `cpp_demo_3d_app/${name}`;
    const file = sourceFiles.find(file => file.path === path);
    assert.equal(file?.language, 'cpp');
    assert.ok(file.code.length > 0);
    assert.equal(sourceLink(path), `/source/${path}/`);
  }
});

test('symbol links survive inserted lines in every indexed language', () => {
  for (const file of sourceFiles) {
    const shifted = indexSymbols('\n\n\n' + file.code, file.language);
    assert.deepEqual(shifted, file.symbols.map(symbol => ({ ...symbol, start: symbol.start + 3, end: symbol.end + 3 })));
    for (const symbol of file.symbols) assert.ok(sourceLink(file.path, symbol.name).endsWith(`#${symbol.name}`));
  }
});

test('TypeScript targets include constructors, methods and arrow callbacks', () => {
  const code = ['export class Integration {', '  constructor() {}',
    '  async start() {', '    const message = "}";', '    return message;', '  }',
    '  refresh = () => {};', '}', 'export function display() {}'].join('\n');
  const symbols = indexSymbols(code, 'typescript');
  assert.deepEqual(symbols.find(symbol => symbol.name === 'Integration.start'),
    { name: 'Integration.start', start: 3, end: 6 });
  for (const name of ['Integration.constructor', 'Integration.refresh', 'display'])
    assert.ok(symbols.some(symbol => symbol.name === name), name);
});

test('missing and ambiguous symbols fail validation', () => {
  assert.throws(() => sourceLink(sourceFiles[0].path, 'RemovedClass'), /Unknown demo source/);
  assert.throws(() => sourceLink('../private.txt'), /Unknown demo source/);
  assert.throws(() => indexSymbols('class Duplicate:\n    pass\nclass Duplicate:\n    pass', 'python'), /Ambiguous/);
});

test('method targets exclude adjacent methods and survive nested bodies', () => {
  const python = indexSymbols('class Integration:\n    async def start(self):\n        if True:\n            connect()\n\n    def stop(self):\n        close()', 'python');
  assert.deepEqual(python.find(symbol => symbol.name === 'Integration.start'), { name: 'Integration.start', start: 2, end: 4 });
  const csharp = indexSymbols('public class Integration\n{\n    public Integration()\n    {\n        Run(() => { Log("}"); });\n    }\n    public void Stop() => Close();\n}', 'csharp');
  assert.deepEqual(csharp.find(symbol => symbol.name === 'Integration.Integration'), { name: 'Integration.Integration', start: 3, end: 6 });
  assert.deepEqual(csharp.find(symbol => symbol.name === 'Integration.Stop'), { name: 'Integration.Stop', start: 7, end: 7 });
});
