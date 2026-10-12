/**
 * Static import scan (Python spec §6.2): orients backend selection, never a security control. The
 * scan runs without an interpreter, so these tests pin what it sees and what it refuses to see.
 */
import { describe, expect, it } from "vitest";
import {
  classifyModules,
  packageOfModule,
  scanImports,
} from "../packages/core/src/forge/python/import-scan.ts";

describe("scanImports", () => {
  it("collects the top-level names of import and from-import statements, in order, once", () => {
    const code = [
      "import os, sys",
      "import pandas as pd",
      "from sklearn.linear_model import LogisticRegression",
      "import numpy.linalg as la",
      "from pandas import DataFrame",
    ].join("\n");
    expect(scanImports(code)).toEqual(["os", "sys", "pandas", "sklearn", "numpy"]);
  });

  it("sees indented imports (try, function bodies) and semicolon-joined statements", () => {
    const code =
      "def f():\n    import scipy.stats\ntry:\n    import openpyxl; import docx\nexcept ImportError: pass";
    expect(scanImports(code)).toEqual(["scipy", "openpyxl", "docx"]);
  });

  it("ignores relative imports, comments and every kind of string", () => {
    const code = [
      "from . import sibling",
      "from .pkg import thing",
      "# import seaborn",
      "x = 'import torch'",
      'y = "from tensorflow import keras"',
      'doc = """',
      "import requests",
      '"""',
      "z = '''import flask'''",
      "import json  # import yaml",
    ].join("\n");
    expect(scanImports(code)).toEqual(["json"]);
  });

  it("reads a from-import with a parenthesized, multi-line name list as one module", () => {
    const code = "from matplotlib import (\n    pyplot,\n    cm,\n)\nimport re";
    expect(scanImports(code)).toEqual(["matplotlib", "re"]);
  });

  it("does not take words that merely contain 'import' for statements", () => {
    expect(scanImports("important = 1\nreimport(x)\nprint('a', end=import_value)")).toEqual([]);
  });

  it("an apostrophe in a comment or an escaped quote in a string does not swallow what follows", () => {
    expect(scanImports("# don't panic\nimport pandas")).toEqual(["pandas"]);
    expect(scanImports("x = 'it\\'s fine'\nimport numpy")).toEqual(["numpy"]);
    expect(scanImports('y = "say \\"hi\\""\nimport scipy')).toEqual(["scipy"]);
  });

  it("a single-quoted string that never closes ends at its line, a triple-quoted one at its own quotes", () => {
    expect(scanImports("s = 'never closed\nimport pandas")).toEqual(["pandas"]);
    expect(scanImports('t = """a\nimport torch\n"""\nimport csv')).toEqual(["csv"]);
  });

  it("copes with unterminated strings and empty source", () => {
    expect(scanImports("")).toEqual([]);
    expect(scanImports("import json\ns = 'never closed")).toEqual(["json"]);
  });
});

describe("packageOfModule", () => {
  it("translates import names that differ from the package name", () => {
    expect(packageOfModule("sklearn")).toBe("scikit-learn");
    expect(packageOfModule("docx")).toBe("python-docx");
    expect(packageOfModule("PIL")).toBe("pillow");
    expect(packageOfModule("dateutil")).toBe("python-dateutil");
    expect(packageOfModule("pandas")).toBe("pandas");
  });

  it("does not know the standard library or strangers", () => {
    expect(packageOfModule("json")).toBeUndefined();
    expect(packageOfModule("torch")).toBeUndefined();
  });
});

describe("classifyModules", () => {
  it("separates the standard library, the Alisio helpers, wheel-backed packages and strangers", () => {
    const result = classifyModules(["os", "alisio_runtime", "pandas", "sklearn", "torch"]);
    expect(result.profile).toBe("science");
    expect(result.packages).toEqual(["pandas", "scikit-learn"]);
    expect(result.unknown).toEqual(["torch"]);
  });

  it("lists a package once even when several import names lead to it", () => {
    expect(classifyModules(["matplotlib", "mpl_toolkits", "pylab"]).packages).toEqual([
      "matplotlib",
    ]);
  });

  it("asks for the analysis profile for the office and plotting wheels, and for none otherwise", () => {
    expect(classifyModules(["openpyxl", "docx", "plotly", "reportlab", "matplotlib"]).profile).toBe(
      "analysis",
    );
    expect(classifyModules(["json", "csv", "sqlite3"]).profile).toBe("base");
  });

  it("treats a package that only ships inside the science profile as science", () => {
    expect(classifyModules(["statsmodels"]).profile).toBe("science");
    expect(classifyModules(["scipy", "numpy"]).profile).toBe("science");
  });

  it("the modules Pyodide provides itself (js, pyodide) need no package", () => {
    expect(classifyModules(["js", "pyodide", "pyodide_js"])).toEqual({
      profile: "base",
      packages: [],
      unknown: [],
    });
  });

  it("the helpers module of Alisio and its submodules are always available", () => {
    expect(classifyModules(["alisio_runtime"]).unknown).toEqual([]);
  });
});
