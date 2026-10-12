/**
 * Static import scan of a Python script (Python spec §6.2). Pure and interpreter-free: it reads the
 * top-level module names a script imports so the backend selector can tell whether the Pyodide
 * profiles that were downloaded cover it. It is NOT a security control: `__import__`,
 * `importlib` and `exec` are invisible to it, and a wrong guess only means the run fails with
 * `PACKAGE_UNAVAILABLE` and is never retried elsewhere (PD5).
 */
import { PYODIDE_PROFILES, type PyodideProfile } from "./pyodide-manifest.ts";

/** Source with comments and string contents removed; newlines and line structure stay. */
function stripStringsAndComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    if (c === "#") {
      while (i < n && source.charAt(i) !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      while (i < n && !source.startsWith(close, i)) {
        if (source.charAt(i) === "\\") i++;
        // A single-quoted string ends at the line, even when it was never closed.
        else if (!triple && source.charAt(i) === "\n") break;
        i++;
      }
      if (source.startsWith(close, i)) i += close.length;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const IMPORT = /^\s*(?:\w[^:]*:\s*)?import\s+(.+)$/;
const FROM = /^\s*(?:\w[^:]*:\s*)?from\s+(\.*)([\w.]*)\s+import\b/;

/** Top-level module names imported by `source`, in order of appearance, without repeats. */
export function scanImports(source: string): string[] {
  const found = new Set<string>();
  const code = stripStringsAndComments(source).replace(/\\\r?\n/g, " ");
  for (const line of code.split(/\r?\n/)) {
    for (const statement of line.split(";")) {
      const plain = IMPORT.exec(statement);
      if (plain) {
        for (const part of (plain[1] ?? "").split(",")) {
          const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
          if (name) found.add(name);
        }
        continue;
      }
      const from = FROM.exec(statement);
      if (from && from[1] === "") {
        const name = (from[2] ?? "").split(".")[0];
        if (name) found.add(name);
      }
    }
  }
  return [...found];
}

/** Import name -> package name, for the packages the Pyodide profiles carry. */
const MODULE_PACKAGES: Readonly<Record<string, string>> = {
  numpy: "numpy",
  pandas: "pandas",
  dateutil: "python-dateutil",
  pytz: "pytz",
  six: "six",
  matplotlib: "matplotlib",
  mpl_toolkits: "matplotlib",
  pylab: "matplotlib",
  contourpy: "contourpy",
  cycler: "cycler",
  fontTools: "fonttools",
  kiwisolver: "kiwisolver",
  packaging: "packaging",
  PIL: "pillow",
  pyparsing: "pyparsing",
  jinja2: "jinja2",
  markupsafe: "markupsafe",
  et_xmlfile: "et-xmlfile",
  openpyxl: "openpyxl",
  lxml: "lxml",
  typing_extensions: "typing-extensions",
  docx: "python-docx",
  narwhals: "narwhals",
  plotly: "plotly",
  charset_normalizer: "charset-normalizer",
  reportlab: "reportlab",
  scipy: "scipy",
  patsy: "patsy",
  statsmodels: "statsmodels",
  joblib: "joblib",
  threadpoolctl: "threadpoolctl",
  sklearn: "scikit-learn",
};

/** Top-level standard library modules of CPython 3.10-3.14 (a name list, no interpreter). */
const STDLIB = new Set(
  "__future__ __main__ _thread abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii binhex bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo".split(
    " ",
  ),
);

/** The helpers Alisio copies next to every script. */
const RUNTIME_MODULE = "alisio_runtime";

/** Modules Pyodide itself provides (the JavaScript bridge); nothing to download for them. */
const PYODIDE_MODULES = new Set(["js", "pyodide", "pyodide_js", "_pyodide"]);

/** Package name for an import name, when a Pyodide profile ships it. */
export const packageOfModule = (module: string): string | undefined => MODULE_PACKAGES[module];

export interface ModuleClassification {
  /** The smallest profile that covers every module the wheels provide. */
  profile: PyodideProfile;
  /** Packages the imports need, without repeats. */
  packages: string[];
  /** Modules neither in the standard library nor in any profile. */
  unknown: string[];
}

/** `science` when a package only that profile carries is imported, else `analysis`, else `base`. */
export function classifyModules(modules: readonly string[]): ModuleClassification {
  const packages: string[] = [];
  const unknown: string[] = [];
  for (const module of modules) {
    if (STDLIB.has(module) || PYODIDE_MODULES.has(module) || module === RUNTIME_MODULE) continue;
    const pkg = MODULE_PACKAGES[module];
    if (!pkg) unknown.push(module);
    else if (!packages.includes(pkg)) packages.push(pkg);
  }
  const inAnalysis = new Set(PYODIDE_PROFILES.analysis);
  const profile: PyodideProfile = packages.some((p) => !inAnalysis.has(p))
    ? "science"
    : packages.length
      ? "analysis"
      : "base";
  return { profile, packages, unknown };
}
