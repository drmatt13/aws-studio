// A synchronous TypeScript loader for the read-only inspection worker. The
// ordinary tsx loader starts an esbuild process, so it needs a process grant
// which would also let evaluated project code start an unrestricted process.
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const { checkedTranspile } = require("./checked-transpile.cjs");

const root = process.env.STUDIO_REPOSITORY_ROOT;
const config = root && path.join(root, "tsconfig.json");
const compilerOptions = config && fs.existsSync(config)
  ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config ?? {}, { ...ts.sys, readDirectory: () => [] }, root).options
  : {};
const resolveFilename = Module._resolveFilename;
const extensions = { ".js": [".ts", ".tsx"], ".cjs": [".cts"], ".mjs": [".mts"] };
const typeScript = /\.(?:[cm]?ts|tsx)$/;

Module._resolveFilename = function (request, parent, ...args) {
  try { return resolveFilename.call(this, request, parent, ...args); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || !parent?.filename) throw error;
    if (request.startsWith(".") || path.isAbsolute(request)) {
      const extension = path.extname(request);
      for (const replacement of extensions[extension] ?? []) {
        const alternative = path.resolve(path.dirname(parent.filename), request.slice(0, -extension.length) + replacement);
        if (fs.existsSync(alternative)) return resolveFilename.call(this, alternative, parent, ...args);
      }
    } else if (compilerOptions.paths || compilerOptions.baseUrl) {
      const resolved = projectSource(parent.filename) && ts.resolveModuleName(request, parent.filename, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved && typeScript.test(resolved) && !/\.d\.[cm]?ts$/.test(resolved)) return resolveFilename.call(this, resolved, parent, ...args);
    }
    throw error;
  }
};

function projectSource(filename) {
  const relative = root && path.relative(root, filename);
  return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.split(path.sep).includes("node_modules");
}

function compile(source, filename) {
  const options = projectSource(filename) ? compilerOptions : {};
  const formatMeta = (context) => {
    const visit = node => {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const factory = context.factory;
        const properties = {
          url: pathToFileURL(filename).href,
          filename,
          dirname: path.dirname(filename),
        };
        return factory.createObjectLiteralExpression(Object.entries(properties).map(([name, value]) => factory.createPropertyAssignment(name, factory.createStringLiteral(value))));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitNode(file, visit);
  };
  return checkedTranspile(source, {
    fileName: filename,
    compilerOptions: {
      target: options.target ?? ts.ScriptTarget.ES2022,
      jsx: options.jsx ?? ts.JsxEmit.ReactJSX,
      jsxImportSource: options.jsxImportSource,
      experimentalDecorators: options.experimentalDecorators,
      useDefineForClassFields: options.useDefineForClassFields,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true, inlineSourceMap: true, inlineSources: true,
    },
    transformers: { before: [formatMeta] },
  }, root);
}

const load = (module, filename) => module._compile(compile(fs.readFileSync(filename, "utf8"), filename), filename);
for (const extension of [".ts", ".cts", ".mts", ".tsx"]) Module._extensions[extension] = load;
