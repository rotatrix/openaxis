import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

function examplesDirectory() {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    for (const candidate of [resolve(directory, 'examples'), resolve(directory, 'openaxis/examples')]) {
      if (existsSync(resolve(candidate, 'python_demo_3d_app/application.py'))) return candidate;
    }
    if (dirname(directory) === directory) throw new Error('Cannot locate OpenAxis demo sources');
  }
}
const examples = examplesDirectory();

// Only these working demo files are published by the source viewer.
const paths = [
  'cpp_demo_3d_app/main.cpp',
  'cpp_demo_3d_app/integration.hpp',
  'cpp_demo_3d_app/diagnostic_view.cpp',
  'cpp_demo_3d_app/diagnostic_view.hpp',
  'cpp_demo_3d_app/application.cpp',
  'cpp_demo_3d_app/application.hpp',
  'python_demo_3d_app/application.py',
  'python_demo_3d_app/integration.py',
  'python_demo_3d_app/main.py',
  'csharp_demo_3d_app/MyApplication.cs',
  'csharp_demo_3d_app/RaylibWindow.cs',
  'csharp_demo_3d_app/MyOpenAxisIntegration.cs',
  'csharp_demo_3d_app/Program.cs',
  'typescript_demo_3d_app/application.ts',
  'typescript_demo_3d_app/integration.ts',
  'typescript_demo_3d_app/main.ts',
  'csharp_demo_3d_app/DemoScene.cs',
];

export function indexSymbols(code, language) {
  // C++ currently has file-level source links; do not misparse it as C#.
  if (language === 'cpp') return [];
  if (language === 'typescript') {
    const file = ts.createSourceFile('source.ts', code, ts.ScriptTarget.Latest, true);
    const symbols = [];
    const add = (name, node) => {
      if (symbols.some(symbol => symbol.name === name)) throw new Error(`Ambiguous source symbol: ${name}`);
      symbols.push({ name, start: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        end: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1 });
    };
    for (const node of file.statements) {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
        const name = node.name.text;
        add(name, node);
        if (ts.isClassDeclaration(node)) for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) add(`${name}.constructor`, member);
          else if (ts.isMethodDeclaration(member) || (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer)))
            add(`${name}.${member.name.getText(file)}`, member);
        }
      }
    }
    return symbols;
  }
  const lines = code.split('\n');
  const symbols = [];
  for (const [index, line] of lines.entries()) {
    const match = language === 'python'
      ? /^(?:class |(?:async )?def )(\w+)/.exec(line)
      : /^(?:public|export)\s+(?:(?:sealed|static|abstract|partial)\s+)*(?:class|record|struct)\s+(\w+)/.exec(line);
    if (match) symbols.push({ name: match[1], start: index + 1 });
  }
  for (const [index, symbol] of symbols.entries()) {
    if (symbols.filter(other => other.name === symbol.name).length !== 1)
      throw new Error(`Ambiguous source symbol: ${symbol.name}`);
    symbol.end = (symbols[index + 1]?.start ?? lines.length + 1) - 1;
    while (symbol.end > symbol.start && !lines[symbol.end - 1].trim()) symbol.end--;
  }
  const classes = symbols.filter(symbol => /\bclass\b/.test(lines[symbol.start - 1]));
  // Mask comments and literals so braces inside them cannot end a C# method.
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    value => value.replace(/[^\n]/g, ' ')).split('\n');
  for (const owner of classes) {
    for (let index = owner.start; index < owner.end; index++) {
      const match = language === 'python'
        ? /^    (?:async )?def (\w+)\(/.exec(lines[index])
        : /^    (?:(?:public|private|protected|internal|static|async|virtual|override|sealed)\s+)*(?:[\w<>?,.\[\]]+\s+)?(\w+)\(/.exec(lines[index]);
      if (!match) continue;
      let end = index + 1;
      if (language === 'python') {
        while (end < owner.end && (!lines[end].trim() || /^\s{8}/.test(lines[end]) || /^\s*[)\]}]/.test(lines[end]))) end++;
        while (end > index + 1 && !lines[end - 1].trim()) end--;
      } else {
        let braces = 0, parens = 0, opened = false, done = false;
        for (let row = index; row < owner.end && !done; row++) {
          for (const char of masked[row]) {
            if (char === '(') parens++;
            if (char === ')') parens--;
            if (char === '{') { braces++; opened = true; }
            if (char === '}') braces--;
            if ((opened && braces === 0 && parens === 0) || (char === ';' && braces === 0 && parens === 0)) { done = true; break; }
          }
          end = row + 1;
        }
      }
      const setter = language === 'python' && /@\w+\.setter/.test(lines[index - 1]);
      const name = `${owner.name}.${match[1]}${setter ? '.setter' : ''}`;
      if (symbols.some(symbol => symbol.name === name)) throw new Error(`Ambiguous source symbol: ${name}`);
      symbols.push({ name, start: index + 1, end });
    }
  }
  symbols.sort((a, b) => a.start - b.start);
  return symbols;
}

export const sourceFiles = paths.map(path => {
  const root = examples;
  const code = readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
  const language = path.endsWith('.py') ? 'python' : path.endsWith('.ts') ? 'typescript' : /\.(cpp|hpp)$/.test(path) ? 'cpp' : 'csharp';
  return { path, code, language, symbols: indexSymbols(code, language) };
});

export function sourceLink(path, symbol) {
  const file = sourceFiles.find(file => file.path === path);
  if (!file || (symbol && !file.symbols.some(entry => entry.name === symbol)))
    throw new Error(`Unknown demo source: ${path}#${symbol ?? ''}`);
  return `/source/${path}/${symbol ? `#${symbol}` : ''}`;
}
