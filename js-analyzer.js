"use strict";

(() => {
  const MAX_SOURCE_LENGTH = 200000;
  const sourceInput = document.getElementById("sourceCode");
  const analyzeButton = document.getElementById("analyzeButton");
  const exampleButton = document.getElementById("exampleButton");
  const clearButton = document.getElementById("clearButton");
  const fileInput = document.getElementById("fileInput");
  const summary = document.getElementById("summary");
  const findingList = document.getElementById("findingList");
  const resultCount = document.getElementById("resultCount");

  const exampleSource = `const players = ["Steve", "Alex", "Notch"];

function startGame(player) {
  var playerName = player.name;

  if (playerName == null) {
    console.log("Player name is missing");
  }

  try {
    eval(player.script);
  } catch (error) {
  }

  document.write(playerName);
  setTimeout("startGame()", 1000);
  debugger;
  return playerName;
}

startGame({ name: players[0], script: "" });`;

  function tokenize(source) {
    const tokens = [];
    let index = 0;
    let line = 1;
    let column = 1;
    let previous = null;

    const operators = [
      ">>>=", "**=", "===", "!==", ">>>", "...", "=>", "==", "!=", "<=", ">=", "++", "--",
      "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>", "&=", "|=", "^=", "??="
    ];

    function advance() {
      const character = source[index++];
      if (character === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      return character;
    }

    function add(type, value, startLine, startColumn) {
      const token = { type, value, line: startLine, column: startColumn };
      tokens.push(token);
      if (type !== "comment") previous = token;
    }

    function canStartRegex() {
      if (!previous) return true;
      if (previous.type === "identifier" || previous.type === "number" || previous.type === "string" || previous.type === "template") return false;
      if ([")", "]", "}", "++", "--"].includes(previous.value)) return false;
      return true;
    }

    while (index < source.length) {
      const character = source[index];
      const startLine = line;
      const startColumn = column;

      if (/\s/.test(character)) {
        advance();
        continue;
      }

      if (character === "/" && source[index + 1] === "/") {
        let value = advance() + advance();
        while (index < source.length && source[index] !== "\n") value += advance();
        add("comment", value, startLine, startColumn);
        continue;
      }

      if (character === "/" && source[index + 1] === "*") {
        let value = advance() + advance();
        while (index < source.length) {
          const next = advance();
          value += next;
          if (next === "*" && source[index] === "/") {
            value += advance();
            break;
          }
        }
        add("comment", value, startLine, startColumn);
        continue;
      }

      if (character === "\"" || character === "'") {
        const quote = advance();
        let value = quote;
        while (index < source.length) {
          const next = advance();
          value += next;
          if (next === "\\" && index < source.length) {
            value += advance();
            continue;
          }
          if (next === quote) break;
        }
        add("string", value, startLine, startColumn);
        continue;
      }

      if (character === "`") {
        let value = advance();
        while (index < source.length) {
          const next = advance();
          value += next;
          if (next === "\\" && index < source.length) {
            value += advance();
            continue;
          }
          if (next === "`") break;
        }
        add("template", value, startLine, startColumn);
        continue;
      }

      if (character === "/" && canStartRegex()) {
        let value = advance();
        let inCharacterClass = false;
        while (index < source.length) {
          const next = advance();
          value += next;
          if (next === "\\" && index < source.length) {
            value += advance();
            continue;
          }
          if (next === "[") inCharacterClass = true;
          else if (next === "]") inCharacterClass = false;
          else if (next === "/" && !inCharacterClass) break;
          else if (next === "\n") break;
        }
        while (index < source.length && /[a-z]/i.test(source[index])) value += advance();
        add("regex", value, startLine, startColumn);
        continue;
      }

      if (/[A-Za-z_$]/.test(character)) {
        let value = advance();
        while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) value += advance();
        add("identifier", value, startLine, startColumn);
        continue;
      }

      if (/\d/.test(character)) {
        let value = advance();
        while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) value += advance();
        add("number", value, startLine, startColumn);
        continue;
      }

      const operator = operators.find(candidate => source.startsWith(candidate, index));
      if (operator) {
        for (let i = 0; i < operator.length; i += 1) advance();
        add("punctuator", operator, startLine, startColumn);
        continue;
      }

      add("punctuator", advance(), startLine, startColumn);
    }

    return tokens;
  }

  function getLineText(source, lineNumber) {
    if (!lineNumber || lineNumber < 1) return "";
    return source.split(/\r?\n/)[lineNumber - 1] || "";
  }

  function createFinding(rule, severity, title, message, token, source) {
    const line = token ? token.line : null;
    const column = token ? token.column : null;
    return {
      rule,
      severity,
      title,
      message,
      line,
      column,
      snippet: line ? getLineText(source, line).trim() : ""
    };
  }

  function findMatching(tokens, startIndex, open, close) {
    let depth = 0;
    for (let index = startIndex; index < tokens.length; index += 1) {
      if (tokens[index].value === open) depth += 1;
      if (tokens[index].value === close) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function analyzeSource(source) {
    const tokens = tokenize(source);
    const findings = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1];
      const afterNext = tokens[index + 2];

      if (token.type === "comment") {
        if (/\b(TODO|FIXME|XXX)\b/i.test(token.value)) {
          findings.push(createFinding("LABX-TODO", "info", "Developer reminder found", "This comment contains TODO, FIXME, or XXX. Review it before considering the code finished.", token, source));
        }
        continue;
      }

      if (token.value === "==" || token.value === "!=") {
        findings.push(createFinding("LABX-EQ", "warning", "Loose equality comparison", `The ${token.value} operator performs type coercion. Use ${token.value === "==" ? "===" : "!=="} when you intend a strict comparison, or document why coercion is intentional.`, token, source));
      }

      if (token.value === "var") {
        findings.push(createFinding("LABX-VAR", "warning", "Legacy var declaration", "var is function-scoped and can make variables easier to overwrite accidentally. Prefer const by default, or let when reassignment is needed.", token, source));
      }

      if (token.value === "debugger") {
        findings.push(createFinding("LABX-DEBUG", "warning", "Debugger statement left in source", "Remove debugger statements before shipping production code; they can pause execution when developer tools are open.", token, source));
      }

      if (token.value === "console" && next && next.value === "." && afterNext && ["log", "debug"].includes(afterNext.value)) {
        findings.push(createFinding("LABX-CONSOLE", "info", "Console output detected", "Check whether this diagnostic output should remain in the release build or be routed through a configurable logger.", token, source));
      }

      if (token.value === "eval" && next && next.value === "(") {
        findings.push(createFinding("LABX-EVAL", "error", "Dynamic eval execution", "eval executes a string as code and can introduce injection risks, difficult debugging, and optimization problems. Prefer explicit functions or a safe data format.", token, source));
      }

      if (token.value === "Function" && index > 0 && tokens[index - 1].value === "new" && next && next.value === "(") {
        findings.push(createFinding("LABX-FUNCTION", "warning", "Dynamic Function constructor", "Constructing functions from strings has security and maintainability risks similar to eval. Avoid it for untrusted input.", tokens[index - 1], source));
      }

      if ((token.value === "innerHTML" || token.value === "outerHTML") && next && ["=", "+="].includes(next.value)) {
        findings.push(createFinding("LABX-HTML", "warning", `HTML injection-sensitive assignment (${token.value})`, "Assigning strings to HTML parsing sinks can introduce cross-site scripting when the value contains untrusted input. Prefer textContent or sanitize trusted HTML with a proven sanitizer.", token, source));
      }

      if (token.value === "document" && next && next.value === "." && afterNext && afterNext.value === "write") {
        findings.push(createFinding("LABX-DOCWRITE", "warning", "document.write usage", "document.write can replace or disrupt the document and is generally unsuitable for modern application UI. Prefer DOM APIs.", token, source));
      }

      if (["setTimeout", "setInterval"].includes(token.value) && next && next.value === "(" && afterNext && ["string", "template"].includes(afterNext.type)) {
        findings.push(createFinding("LABX-TIMER", "warning", "String-based timer callback", "Passing code as a string to a timer requires dynamic parsing and can create injection risks. Pass a function instead.", token, source));
      }

      if (token.value === "catch") {
        let bodyIndex = index + 1;
        if (tokens[bodyIndex] && tokens[bodyIndex].value === "(") {
          const closeParen = findMatching(tokens, bodyIndex, "(", ")");
          if (closeParen !== -1) bodyIndex = closeParen + 1;
        }
        if (tokens[bodyIndex] && tokens[bodyIndex].value === "{") {
          const closeBrace = findMatching(tokens, bodyIndex, "{", "}");
          if (closeBrace === bodyIndex + 1) {
            findings.push(createFinding("LABX-CATCH", "warning", "Empty catch block", "The exception is silently discarded. Handle it, log useful context, or add a comment explaining why ignoring it is intentional.", token, source));
          }
        }
      }
    }

    const hasStaticImport = tokens.some((token, index) => token.value === "import" && tokens[index + 1] && !["(", "."].includes(tokens[index + 1].value));
    const hasExport = tokens.some(token => token.value === "export");
    const isModuleSyntax = hasStaticImport || hasExport;

    if (isModuleSyntax) {
      findings.push(createFinding("LABX-MODULE", "info", "ES module syntax detected", "Static import/export syntax was found. The built-in syntax check is designed for script snippets and does not validate full ES module grammar; the source-level checks still ran.", tokens.find(token => token.value === "import" || token.value === "export"), source));
    } else {
      try {
        // Compilation only: this creates a function but never invokes it or executes the supplied source.
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        new AsyncFunction(source);
      } catch (error) {
        const stackMatch = String(error && error.stack || "").match(/<anonymous>:(\d+):(\d+)/);
        const line = stackMatch ? Number(stackMatch[1]) : null;
        const column = stackMatch ? Number(stackMatch[2]) : null;
        findings.push({
          rule: "LABX-SYNTAX",
          severity: "error",
          title: "JavaScript syntax validation failed",
          message: error && error.message ? error.message : "The browser could not parse this source as JavaScript.",
          line,
          column,
          snippet: line ? getLineText(source, line).trim() : ""
        });
      }
    }

    const severityOrder = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => {
      const lineA = a.line || Number.MAX_SAFE_INTEGER;
      const lineB = b.line || Number.MAX_SAFE_INTEGER;
      return lineA - lineB || severityOrder[a.severity] - severityOrder[b.severity];
    });

    return findings;
  }

  function renderFindings(findings, source) {
    findingList.replaceChildren();
    resultCount.textContent = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;

    const counts = findings.reduce((total, finding) => {
      total[finding.severity] += 1;
      return total;
    }, { error: 0, warning: 0, info: 0 });

    if (findings.length === 0) {
      summary.dataset.state = "success";
      summary.textContent = "No issues were detected by the current checks. This does not prove the code is bug-free; review it and run appropriate tests.";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No findings. The current checks did not detect any of the patterns they look for.";
      findingList.append(empty);
      return;
    }

    summary.dataset.state = counts.error > 0 ? "error" : "warning";
    summary.textContent = `${counts.error} error${counts.error === 1 ? "" : "s"} · ${counts.warning} warning${counts.warning === 1 ? "" : "s"} · ${counts.info} note${counts.info === 1 ? "" : "s"}. Review each item below. Findings are suggestions, not proof of a defect.`;

    for (const finding of findings) {
      const article = document.createElement("article");
      article.className = `finding ${finding.severity}`;

      const heading = document.createElement("div");
      heading.className = "finding-head";
      const title = document.createElement("h3");
      title.className = "finding-title";
      title.textContent = `${finding.rule}: ${finding.title}`;
      const badge = document.createElement("span");
      badge.className = "severity";
      badge.textContent = finding.severity;
      heading.append(title, badge);

      const message = document.createElement("p");
      message.textContent = finding.message;
      article.append(heading, message);

      if (finding.line) {
        const location = document.createElement("div");
        location.className = "location";
        location.textContent = `Line ${finding.line}${finding.column ? `, column ${finding.column}` : ""}`;
        article.append(location);
      }
      if (finding.snippet) {
        const code = document.createElement("code");
        code.className = "code-line";
        code.textContent = finding.snippet;
        article.append(code);
      }
      findingList.append(article);
    }
  }

  function analyze() {
    const source = sourceInput.value;
    if (!source.trim()) {
      summary.dataset.state = "warning";
      summary.textContent = "Paste or load JavaScript code before starting the analysis.";
      findingList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No source code was provided.";
      findingList.append(empty);
      resultCount.textContent = "0 findings";
      return;
    }

    if (source.length > MAX_SOURCE_LENGTH) {
      summary.dataset.state = "error";
      summary.textContent = `The source is too large. Keep it under ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`;
      return;
    }

    analyzeButton.disabled = true;
    analyzeButton.textContent = "ANALYZING…";
    try {
      const findings = analyzeSource(source);
      renderFindings(findings, source);
    } catch (error) {
      summary.dataset.state = "error";
      summary.textContent = `The analyzer could not complete: ${error && error.message ? error.message : "Unknown error"}`;
      findingList.replaceChildren();
    } finally {
      analyzeButton.disabled = false;
      analyzeButton.textContent = "ANALYZE CODE";
    }
  }

  analyzeButton.addEventListener("click", analyze);

  exampleButton.addEventListener("click", () => {
    sourceInput.value = exampleSource;
    sourceInput.focus();
    analyze();
  });

  clearButton.addEventListener("click", () => {
    sourceInput.value = "";
    findingList.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No analysis has been run yet.";
    findingList.append(empty);
    summary.dataset.state = "idle";
    summary.textContent = "Ready. Add JavaScript code and select Analyze code.";
    resultCount.textContent = "0 findings";
    sourceInput.focus();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_SOURCE_LENGTH) {
      summary.dataset.state = "error";
      summary.textContent = `That file is too large. Choose a file under ${MAX_SOURCE_LENGTH.toLocaleString()} characters.`;
      fileInput.value = "";
      return;
    }
    try {
      sourceInput.value = await file.text();
      summary.dataset.state = "idle";
      summary.textContent = `Loaded ${file.name}. Select Analyze code to inspect it.`;
      sourceInput.focus();
    } catch (error) {
      summary.dataset.state = "error";
      summary.textContent = `Could not read the selected file: ${error.message}`;
    } finally {
      fileInput.value = "";
    }
  });
})();
