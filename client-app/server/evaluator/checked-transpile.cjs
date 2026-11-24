const path = require("node:path");
const ts = require("typescript");

function checkedTranspile(source, options, repositoryRoot) {
  const { outputText, diagnostics } = ts.transpileModule(source, { ...options, reportDiagnostics: true });
  const error = diagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!error) return outputText;

  const message = ts.flattenDiagnosticMessageText(error.messageText, "\n");
  if (!error.file || error.start === undefined) throw new Error(message);
  const { line, character } = error.file.getLineAndCharacterOfPosition(error.start);
  const file = error.file.fileName;
  const relative = repositoryRoot && path.relative(repositoryRoot, file);
  const inside = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  throw new Error(`${inside ? relative.split(path.sep).join("/") : file}:${line + 1}:${character + 1}: ERROR: ${message}`);
}

module.exports = { checkedTranspile };
